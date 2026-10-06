// 练习页只渲染会话；切换、草稿与提交在此维护。答案校验与熟悉度事实仍由 Core 决定。
export const PRACTICE_MODES = [
  ["word-list", "单词列表"],
  ["meaning-choice", "看词选义"],
  ["copy", "单词临摹"],
  ["recall", "单词默写"],
  ["listening", "听音辨词"],
  ["cloze", "语境填空"],
];
// 所有单题练习确认正确后留出阅读反馈时间；不影响 Core 的记分或 FSRS 日程。
export const PRACTICE_FEEDBACK_DELAY_MS = 1000;
// 单词发音正常应很短；异常播放链路有界等待，不能把练习永久锁住。
export const PRACTICE_AUDIO_WAIT_LIMIT_MS = 30000;
export function practiceAudioBusy(audio, wordId, attemptId) {
  return (
    ["loading", "playing", "completing"].includes(audio?.state) &&
    Number.isSafeInteger(audio?.cue) &&
    audio.wordId === wordId &&
    audio.attemptId === attemptId
  );
}
export function createPracticeState(range = "library", mode = "word-list") {
  return {
    range,
    mode,
    cursor: 0,
    total: 0,
    word: null,
    rows: [],
    attemptId: "",
    pendingSubmission: null,
    choices: [],
    question: null,
    questionUnavailable: false,
    hintSubmissionId: "",
    hintReadPending: false,
    listAttempts: {},
    input: "",
    answered: null,
    roundComplete: false,
    assisted: false,
    loading: false,
    submitting: false,
    transitioning: false,
    autoNext: true,
    repeat: 1,
    repeatDone: 0,
    error: "",
    pendingRange: "",
  };
}
// 三类反馈都可能已提交但回复未确认；重开前须保留原事件身份以便安全重试。
export function hasPendingPracticeFeedback(state) {
  return !!(
    state.pendingSubmission ||
    (state.mode === "word-list" &&
      Object.values(state.listAttempts).some((attempt) => attempt.pending)) ||
    (state.hintSubmissionId && !state.assisted)
  );
}
export function createPracticeSession({
  state: s,
  query,
  save,
  record,
  workspace,
  onReady = () => {},
  onModeChange = () => {},
  audio = () => null,
  lockInitialMode = false,
  id = () => crypto.randomUUID(),
}) {
  const pageSize = 12;
  let loaded,
    disposed = false,
    generation = 0,
    saveQueue = Promise.resolve(),
    persistTimer,
    advanceTimer;
  let todayIds = [],
    refreshPending = false;
  // 重开只属于当前范围与模式；换到其他模式不能抹去它的已完成题目或列表回忆。
  const freshRounds = new Map();
  const scopeFor = (range, context) =>
    range === "goal"
      ? `goal:${context.profile.goal || "none"}`
      : range === "today"
        ? `today:${context.today}`
        : range;
  const blocked = () => disposed || s.loading || s.submitting || s.transitioning;
  const cancelAdvance = () => clearTimeout(advanceTimer);
  // 目标或日期可在查询/提交期间变化；等当前操作结束后只重载一次。
  function drainRefresh() {
    if (!refreshPending || blocked() || hasPendingPracticeFeedback(s)) return;
    refreshPending = false;
    void refreshScope();
  }
  function persist() {
    clearTimeout(persistTimer);
    if (!loaded || !s.word) return saveQueue;
    const payload = JSON.parse(
      JSON.stringify({
        action: "practiceSave",
        ...loaded,
        draft: {
          input: s.input,
          answered: s.answered,
          assisted: s.assisted,
          repeatDone: s.repeatDone,
          roundComplete: s.roundComplete,
          attemptId: s.attemptId,
          pendingSubmission: s.pendingSubmission,
          hintSubmissionId: s.hintSubmissionId,
          hintReadPending: s.hintReadPending,
          // 仅保存本页反馈；每个草稿有界，避免长期练习扩大单条写入。
          listAttempts: Object.fromEntries(
            s.rows.map((row) => [row.id, s.listAttempts[row.id]]).filter(([, value]) => value),
          ),
        },
        ...(loaded.range === "today" ? { rangeIds: [...todayIds] } : {}),
      }),
    );
    delete payload.range;
    saveQueue = saveQueue
      .then(() => save(payload))
      .then(() => true)
      .catch((failure) => {
        if (!disposed) s.error = `草稿未保存：${failure.message}`;
        return false;
      });
    return saveQueue;
  }
  async function load({
    range = s.range,
    mode = s.mode,
    cursor = s.cursor,
    resume = false,
    preserveMode = false,
    reset = false,
  } = {}) {
    if (disposed) return false;
    const ticket = ++generation,
      context = workspace(),
      scope = scopeFor(range, context);
    const current = () => !disposed && ticket === generation;
    s.loading = true;
    s.error = "";
    cancelAdvance();
    clearTimeout(persistTimer);
    try {
      let position = await query({
        kind: "practice",
        scope,
        mode,
        ...(reset ? { reset: true } : {}),
      });
      if (!current()) return false;
      if (resume) {
        // 首次进入可恢复最后使用方式；切换、换范围与刷新必须保留显式请求的模式。
        const lastMode = position.lastMode || position.mode;
        if (!preserveMode && !lockInitialMode && lastMode && lastMode !== mode) {
          mode = lastMode;
          position = await query({ kind: "practice", scope, mode });
          if (!current()) return false;
        }
        cursor = position.cursor || 0;
      }
      const rangeIds = range === "today" ? position.rangeIds || [] : [];
      let start, result;
      // 范围缩小只会回退一次，避免空结果递归或越界游标。
      for (let attempt = 0; attempt < 2; attempt++) {
        start = mode === "word-list" ? Math.floor(cursor / pageSize) * pageSize : cursor;
        const limit = mode === "word-list" ? pageSize : 1;
        result = await query({
          kind: "practiceWords",
          scope,
          // 各模式可保留自己的冻结范围；重开一个模式后，其他模式仍读原词序。
          mode,
          offset: start,
          limit,
        });
        if (!current()) return false;
        if (cursor < result.total || !result.total) break;
        cursor = result.total - 1;
      }
      if (!result.total) cursor = 0;
      const row = result.words[mode === "word-list" ? cursor - start : 0];
      const detail = row ? await query({ kind: "detail", wordId: row.id }) : null;
      if (!current()) return false;
      const stored = detail
        ? await query({ kind: "practice", scope, mode, wordId: detail.id })
        : null;
      if (!current()) return false;
      const freshKey = `${scope}:${mode}:${detail?.id}`;
      const freshRound = freshRounds.get(`${scope}:${mode}`);
      // 查询经 IPC 再进入 Vue 后，始终按普通对象重建；新一轮不能恢复上一轮的已完成反馈。
      const fresh = freshRound && !freshRound.has(freshKey);
      // 教学重进时，已完成草稿会使输入变为只读且没有新的成功回执，造成卡关。
      // 仅重开当前教学题；保留未完成输入与失败请求的幂等身份。
      const completedLesson =
        lockInitialMode &&
        mode === "copy" &&
        stored?.draft?.answered === true &&
        !stored.draft.pendingSubmission;
      const draft = fresh || completedLesson ? {} : stored?.draft || {};
      if (freshRound) freshRound.add(freshKey);
      const attemptId = draft.attemptId || id();
      // 列表回忆只属于当前范围的列表模式，不能污染临摹或另一个学习目标。
      const listAttempts =
        mode !== "word-list" || fresh
          ? {}
          : {
              ...(loaded?.scope === scope && loaded.mode === "word-list" ? s.listAttempts : {}),
              ...draft.listAttempts,
            };
      // 先冻结本页每个列表项，再显示释义。资料更新不得中途改变题目或答案。
      const rows =
        mode === "word-list"
          ? await Promise.all(
              result.words.map(async (item, index) => {
                const previous = listAttempts[item.id];
                // 隔夜重进也先恢复未知回执，不能因学习日变化替换重试所需的事件身份。
                const attempt =
                  previous?.pending || previous?.day === context.today
                    ? previous
                    : { id: id(), day: context.today };
                listAttempts[item.id] = attempt;
                const question = await query({
                  kind: "practiceQuestion",
                  scope,
                  cursor: start + index,
                  wordId: item.id,
                  mode,
                  attemptId: attempt.id,
                });
                return frozenWord(item, question);
              }),
            )
          : result.words;
      const question =
        detail && mode !== "word-list"
          ? await query({
              kind: "practiceQuestion",
              scope,
              cursor,
              wordId: detail.id,
              mode,
              attemptId,
            })
          : null;
      if (!current()) return false;
      // 所有依赖成功后再一次性发布，失败时原单词与输入仍留在页面上。
      Object.assign(s, {
        range,
        mode,
        cursor,
        attemptId,
        pendingSubmission: draft.pendingSubmission || null,
        choices: question?.options || [],
        question,
        questionUnavailable: question?.unavailable === true,
        hintSubmissionId: draft.hintSubmissionId || "",
        listAttempts,
        total: result.total,
        rows,
        word: question ? frozenWord(detail, question) : detail,
        input: question?.unavailable
          ? ""
          : draft.hintReadPending && draft.assisted && mode === "meaning-choice"
            ? question?.revealedChoiceId || ""
            : draft.input || "",
        answered: question?.unavailable ? null : (draft.answered ?? null),
        assisted: draft.assisted || false,
        // 恢复时已成功读回同一冻结题目；无需再次发送扣分反馈。
        hintReadPending: false,
        repeatDone: draft.repeatDone || 0,
        roundComplete: draft.roundComplete || false,
        error: question?.unavailable ? question.reason : "",
      });
      todayIds = rangeIds;
      loaded = detail ? { scope, range, cursor, mode, wordId: detail.id } : null;
      await persist();
      if (current()) {
        s.loading = false;
        await onReady();
        // 恢复已确认的题目也要继续，不能留下只读答案却没有下一步入口。
        scheduleAdvance();
      }
      return current();
    } catch (failure) {
      if (current()) s.error = failure.message;
      return false;
    } finally {
      if (current()) {
        s.loading = false;
        drainRefresh();
      }
    }
  }
  function frozenWord(detail, question) {
    return { ...detail, word: question.word, meaning: question.meaning };
  }
  function requireFeedback(result, submissionId) {
    if (!result) return false;
    if (result.submissionId !== submissionId || typeof result.correct !== "boolean")
      throw new Error("练习回执不匹配，请重试当前答案");
    return result;
  }
  // 回执确认先于工作区发布；教学切页或用户离开后，也须清除原草稿的待确认标记。
  async function recordConfirmed(payload, confirm) {
    let acknowledged = false;
    const accept = async (result) => {
      if (!requireFeedback(result, payload.submissionId)) return false;
      if (!acknowledged) {
        // Core 已确认不等于页面草稿已保存。冻结原身份，失败时仍可重试同一事件。
        const before = JSON.parse(
          JSON.stringify({
            input: s.input,
            answered: s.answered,
            assisted: s.assisted,
            repeatDone: s.repeatDone,
            roundComplete: s.roundComplete,
            attemptId: s.attemptId,
            pendingSubmission: s.pendingSubmission,
            hintSubmissionId: s.hintSubmissionId,
            hintReadPending: s.hintReadPending,
            listAttempts: s.listAttempts,
          }),
        );
        try {
          await confirm(result);
          if ((await persist()) === false)
            throw new Error(`练习结果已确认，${s.error || "确认草稿未保存"}；请重试原反馈。`);
          acknowledged = true;
        } catch (failure) {
          const { listAttempts, ...draft } = before;
          Object.assign(s, draft);
          // 列表确认闭包持有 attempt 引用；原位恢复其字段，避免重试读到已清空的对象。
          for (const [key, previous] of Object.entries(listAttempts)) {
            const attempt = s.listAttempts[key];
            if (!attempt) s.listAttempts[key] = previous;
            else {
              for (const field of Object.keys(attempt)) delete attempt[field];
              Object.assign(attempt, previous);
            }
          }
          if (!disposed) s.error = failure.message;
          throw failure;
        }
      }
      return result;
    };
    const result = await record(payload, accept);
    return acknowledged ? result : accept(result);
  }
  // 先锁定，再等草稿落盘。连续点击不会同时发起两次换词。
  async function transition(work) {
    if (blocked()) return false;
    s.transitioning = true;
    cancelAdvance();
    try {
      if ((await persist()) === false || disposed) return false;
      return await work();
    } catch (failure) {
      if (!disposed) s.error = failure.message;
      return false;
    } finally {
      s.transitioning = false;
      if (!disposed) await onReady(false);
      drainRefresh();
    }
  }
  function typing(value) {
    if (blocked() || s.answered === true) return;
    // 未确认答案只能原样重试，不能以新输入替换掉唯一可查回执的提交 ID。
    if (s.pendingSubmission && value !== s.pendingSubmission.answer) return;
    s.input = value;
    if (s.answered === false) s.answered = null;
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 250);
  }
  async function switchMode(mode) {
    if (s.pendingRange || s.mode === mode || !allowNewQuestion()) return false;
    return transition(async () => {
      onModeChange();
      return load({ mode, resume: true, preserveMode: true });
    });
  }
  function requestRange(range) {
    if (blocked() || range === s.range || !allowNewQuestion()) return;
    cancelAdvance();
    if (s.word) s.pendingRange = range;
    else void switchRange(range);
  }
  async function switchRange(range) {
    if (!allowNewQuestion()) return false;
    return transition(async () => {
      onModeChange();
      if (await load({ range, resume: true, preserveMode: true })) s.pendingRange = "";
    });
  }
  async function signal(item, signal) {
    if (blocked()) return false;
    const index = s.rows.findIndex((row) => row.id === item.id);
    if (index < 0) return false;
    const previous = s.listAttempts[item.id];
    // 首次写入可能已成功；跨天的恢复须先重发原事件，再刷新到新学习日。
    const attempt =
      previous?.pending || previous?.day === workspace().today
        ? previous
        : { id: id(), day: workspace().today };
    if (attempt.finished || (signal === "reveal" && attempt.revealed)) return false;
    // 网络重试复用同一幂等键；不能在失败后重新生成事件。
    attempt.pending ||= { signal, submissionId: id() };
    if (attempt.pending.signal !== signal) return false;
    s.listAttempts[item.id] = attempt;
    return transition(async () => {
      if (
        !(await recordConfirmed(
          {
            action: "practiceRecord",
            wordId: item.id,
            mode: "word-list",
            scope: loaded.scope,
            cursor: Math.floor(s.cursor / pageSize) * pageSize + index,
            signal,
            attemptId: attempt.id,
            submissionId: attempt.pending.submissionId,
          },
          async () => {
            delete attempt.pending;
            if (signal === "reveal") attempt.revealed = true;
            else attempt.finished = signal;
          },
        ))
      )
        return false;
      if (disposed) return true;
      const detail = await query({ kind: "detail", wordId: item.id });
      if (disposed) return false;
      s.rows[index] = { ...detail, word: item.word, meaning: item.meaning };
      s.word = detail;
      s.cursor = Math.floor(s.cursor / pageSize) * pageSize + index;
      loaded = { ...loaded, cursor: s.cursor, wordId: detail.id };
      await persist();
      return true;
    });
  }
  async function submit() {
    if (s.hintSubmissionId && !s.assisted) {
      allowNewQuestion();
      return false;
    }
    if (
      blocked() ||
      !s.word ||
      s.questionUnavailable ||
      !s.input.trim() ||
      (s.answered === true && !s.pendingSubmission) ||
      s.pendingRange
    )
      return false;
    s.submitting = true;
    s.error = "";
    cancelAdvance();
    clearTimeout(persistTimer);
    const wordId = s.word.id,
      answer = s.input;
    try {
      // 回复丢失后重试同一答案，沿用已落盘事件 ID；同题订正仍共享 attemptId。
      if (s.pendingSubmission?.answer !== answer) s.pendingSubmission = { id: id(), answer };
      if ((await persist()) === false || disposed) return false;
      const saved = await recordConfirmed(
        {
          action: "practiceRecord",
          wordId,
          mode: s.mode,
          scope: loaded.scope,
          cursor: s.cursor,
          ...(s.mode === "meaning-choice" ? { choiceId: answer } : { answer }),
          attemptId: s.attemptId,
          submissionId: s.pendingSubmission.id,
        },
        async (saved) => {
          s.pendingSubmission = null;
          // 用户也可自行作答；结果确认后，不再恢复已结束题目的提示读取。
          s.hintReadPending = false;
          // 提交结果与输入绑定，不能使用等待期间被其他控件改写的输入。
          s.answered = saved.correct;
          if (s.answered) s.repeatDone++;
          if (s.answered && s.repeatDone < Math.max(1, Math.min(10, Number(s.repeat) || 1))) {
            s.input = "";
            s.answered = null;
          }
        },
      );
      if (!saved) return false;
      if (disposed) return true;
      // 详情刷新失败不回滚已确认的练习，也不允许重复提交同一个答案。
      try {
        const detail = await query({ kind: "detail", wordId });
        if (!disposed) s.word = frozenWord(detail, s.question);
      } catch (failure) {
        if (!disposed) s.error = `练习已保存，详情刷新失败：${failure.message}`;
      }
      scheduleAdvance();
      return true;
    } catch (failure) {
      if (!disposed) s.error = failure.message;
      return false;
    } finally {
      s.submitting = false;
      drainRefresh();
    }
  }
  // 新回执和恢复草稿共用推进规则；列表没有自动翻页，完成一轮也不再继续。
  function scheduleAdvance() {
    cancelAdvance();
    if (
      s.mode === "word-list" ||
      s.answered !== true ||
      s.roundComplete ||
      !s.autoNext ||
      s.error ||
      hasPendingPracticeFeedback(s)
    )
      return;
    const ticket = generation,
      attemptId = s.attemptId,
      wordId = s.word.id;
    const audioDeadline = Date.now() + PRACTICE_FEEDBACK_DELAY_MS + PRACTICE_AUDIO_WAIT_LIMIT_MS;
    const advance = () => {
      // 定时器只属于这道已确认的题目；重开、切换、未知回执或销毁不能推进后来的页面。
      if (
        !disposed &&
        ticket === generation &&
        attemptId === s.attemptId &&
        s.answered === true &&
        s.autoNext &&
        !s.error &&
        !hasPendingPracticeFeedback(s)
      ) {
        // 只等待当前题的当前播放 cue；一秒是最短反馈期，挂起最多额外等待 30 秒。
        if (practiceAudioBusy(audio(), wordId, attemptId) && Date.now() < audioDeadline) {
          advanceTimer = setTimeout(advance, 100);
          return;
        }
        void next();
      }
    };
    advanceTimer = setTimeout(advance, PRACTICE_FEEDBACK_DELAY_MS);
  }
  async function hint() {
    if (
      blocked() ||
      s.answered === true ||
      !s.word ||
      (s.assisted && !s.hintReadPending) ||
      s.questionUnavailable
    )
      return;
    if (s.pendingSubmission) {
      allowNewQuestion();
      return;
    }
    s.submitting = true;
    s.error = "";
    try {
      // 提示扣分与答案读取是两个独立阶段；读取失败只重读原题，不重放已确认扣分。
      if (!s.assisted) {
        s.hintSubmissionId ||= id();
        if ((await persist()) === false || disposed) return;
        if (
          !(await recordConfirmed(
            {
              action: "practiceRecord",
              wordId: s.word.id,
              mode: s.mode,
              scope: loaded.scope,
              cursor: s.cursor,
              signal: "reveal",
              attemptId: s.attemptId,
              submissionId: s.hintSubmissionId,
            },
            async () => {
              s.assisted = true;
              s.hintReadPending = true;
            },
          ))
        )
          return;
      }
      if (disposed) return;
      const question = await query({
        kind: "practiceQuestion",
        scope: loaded.scope,
        cursor: s.cursor,
        wordId: s.word.id,
        mode: s.mode,
        attemptId: s.attemptId,
      });
      if (disposed) return;
      s.question = question;
      s.questionUnavailable = question.unavailable === true;
      s.hintReadPending = false;
      s.choices = question.options || [];
      if (s.mode === "meaning-choice") s.input = question.revealedChoiceId || "";
      // 拼写答案只显示为幽灵文字，不替用户填满真实输入；已有草稿与光标语义继续保留。
      s.word = frozenWord(s.word, question);
      await persist();
      try {
        const detail = await query({ kind: "detail", wordId: s.word.id });
        if (!disposed) s.word = frozenWord(detail, question);
      } catch (failure) {
        if (!disposed) s.error = `提示已显示，详情刷新失败：${failure.message}`;
      }
    } catch (failure) {
      s.error = failure.message;
    } finally {
      s.submitting = false;
      if (!disposed && s.assisted && !s.hintReadPending) await onReady(false);
      drainRefresh();
    }
  }
  async function retry() {
    if (!allowNewQuestion()) return false;
    return transition(async () => {
      const attemptId = id();
      const question = await query({
        kind: "practiceQuestion",
        scope: loaded.scope,
        cursor: s.cursor,
        wordId: s.word.id,
        mode: s.mode,
        attemptId,
      });
      if (disposed) return false;
      Object.assign(s, {
        input: "",
        answered: null,
        assisted: false,
        repeatDone: 0,
        attemptId,
        pendingSubmission: null,
        hintSubmissionId: "",
        hintReadPending: false,
      });
      s.question = question;
      s.questionUnavailable = question.unavailable === true;
      s.error = s.questionUnavailable ? question.reason : "";
      s.choices = s.question.options || [];
      s.word = frozenWord(s.word, s.question);
      await persist();
      await onReady(false);
    });
  }
  async function next(direction = 1) {
    if (s.pendingRange || !allowNewQuestion()) return false;
    return transition(async () => {
      if (direction === 1 && s.cursor + 1 >= s.total && s.answered === true) {
        s.roundComplete = true;
        return persist();
      }
      return load({
        cursor: Math.max(0, Math.min(s.total - 1, s.cursor + direction)),
      });
    });
  }
  function allowNewQuestion() {
    if (hasPendingPracticeFeedback(s)) {
      s.error = "有练习结果尚未确认，请先重试原反馈。";
      return false;
    }
    return true;
  }
  // 只重发未确认的原事件，不制造新分数；失败后始终有明确可见的恢复入口。
  async function recoverFeedback() {
    if (blocked()) return false;
    s.error = "";
    if (s.pendingSubmission) return submit();
    if (s.hintSubmissionId && (!s.assisted || s.hintReadPending)) {
      await hint();
      return !hasPendingPracticeFeedback(s) && !s.hintReadPending;
    }
    for (const row of s.rows) {
      const pending = s.listAttempts[row.id]?.pending;
      if (pending && !(await signal(row, pending.signal))) return false;
    }
    return !hasPendingPracticeFeedback(s);
  }
  async function restartRound() {
    // 结果尚未确认时保留原提交身份，不能通过重开丢掉重试所需的幂等事件。
    if (!allowNewQuestion()) return false;
    return transition(async () => {
      freshRounds.set(`${loaded.scope}:${s.mode}`, new Set());
      s.listAttempts = {};
      return load({ cursor: 0, reset: true });
    });
  }
  async function refreshScope() {
    if (blocked() || hasPendingPracticeFeedback(s)) {
      refreshPending = true;
      return;
    }
    return transition(() => load({ resume: true, preserveMode: true }));
  }
  return {
    load,
    typing,
    switchMode,
    requestRange,
    switchRange,
    signal,
    submit,
    hint,
    retry,
    next,
    restartRound,
    recoverFeedback,
    refreshScope,
    persist,
    dispose() {
      cancelAdvance();
      clearTimeout(persistTimer);
      void persist();
      disposed = true;
      generation++;
    },
  };
}
