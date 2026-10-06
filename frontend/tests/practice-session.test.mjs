import test from "node:test";
import assert from "node:assert/strict";
import {
  createPracticeState,
  createPracticeSession,
  hasPendingPracticeFeedback,
  practiceAudioBusy,
  PRACTICE_AUDIO_WAIT_LIMIT_MS,
} from "../src/desktop/practice-session.js";
import { createWorkspaceController } from "../src/desktop/workspace-controller.js";
const feedback = (q, correct = true) => ({
  submissionId: q.submissionId,
  correct,
  effective: true,
  delta: correct ? 1 : -1,
});
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture(overrides = {}) {
  const state = overrides.state || createPracticeState(),
    words = ["apple", "banana", "cherry"].map((word) => ({ id: word, word }));
  const drafts = new Map(),
    positions = new Map(),
    lastModes = new Map(),
    modeQueues = new Map(),
    records = [],
    saves = [];
  const workspace = {
    profile: { goal: "" },
    today: "2026-10-01",
    queue: { tasks: words },
  };
  const query = async (q) => {
    const key = `${q.scope}:${q.mode}`;
    if (q.kind === "practice" && !q.wordId) {
      if (!modeQueues.has(key) || q.reset) modeQueues.set(key, [...words]);
      if (q.reset) {
        positions.delete(key);
        for (const draftKey of drafts.keys())
          if (draftKey.startsWith(`${key}:`)) drafts.delete(draftKey);
      }
    }
    const queue = modeQueues.get(key) || words;
    return q.kind === "practiceQuestion"
      ? {
          questionId: q.attemptId,
          wordId: q.wordId,
          word: q.wordId,
          meaning: "冻结释义",
          options: [
            { id: "choice-A", text: "释义 A" },
            { id: "choice-B", text: "释义 B" },
          ],
          revealedChoiceId: "choice-B",
          context: "Frozen _____ context",
        }
      : q.kind === "detail"
        ? { ...words.find((word) => word.id === q.wordId) }
        : q.kind === "practice"
          ? q.wordId
            ? { draft: drafts.get(`${q.scope}:${q.mode}:${q.wordId}`) }
            : {
                ...(positions.get(`${q.scope}:${q.mode}`) || {}),
                mode: q.mode,
                lastMode: lastModes.get(q.scope) || q.mode,
              }
          : q.scope === "goal:none"
            ? { total: 0, words: [] }
            : {
                total: queue.length,
                words: queue.slice(q.offset, q.offset + q.limit),
              };
  };
  const save = async (q) => {
    saves.push(q);
    drafts.set(`${q.scope}:${q.mode}:${q.wordId}`, { ...q.draft });
    positions.set(`${q.scope}:${q.mode}`, {
      cursor: q.cursor,
      mode: q.mode,
      rangeIds: q.rangeIds,
    });
    lastModes.set(q.scope, q.mode);
  };
  const record = async (q) => {
    records.push(q);
    return feedback(q);
  };
  const options = {
    state,
    query,
    save,
    record,
    workspace: () => workspace,
    ...overrides,
  };
  return {
    state,
    controller: createPracticeSession(options),
    words,
    drafts,
    positions,
    lastModes,
    records,
    saves,
    workspace,
    query,
    save,
  };
}

test("教学发布立即卸载时，已确认临摹草稿不会残留 pending 且重进可以重开", async () => {
  let f;
  f = fixture({
    state: createPracticeState("library", "copy"),
    record: async (q, confirmed) => {
      const ack = feedback(q);
      await confirmed(ack);
      // 模拟工作区发布教学进度，Vue 随即卸载当前页面。
      f.controller.dispose();
      return ack;
    },
  });
  await f.controller.load();
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), true);
  await f.controller.persist();
  const draft = f.drafts.get("library:copy:apple");
  assert.equal(draft.pendingSubmission, null);
  assert.equal(draft.answered, true);
  const next = fixture({ state: createPracticeState("library", "copy") });
  next.drafts.set("library:copy:apple", draft);
  await next.controller.load();
  assert.equal(hasPendingPracticeFeedback(next.state), false);
  assert.equal(await next.controller.restartRound(), true);
  next.controller.dispose();
});

test("列表确认后详情失败不变为未确认，恢复不重复计分；重试入口沿用原事件", async () => {
  let queryFailed = false;
  const f = fixture();
  const state = createPracticeState();
  let first = true;
  const records = [];
  const session = createPracticeSession({
    state,
    workspace: () => f.workspace,
    save: f.save,
    query: async (q) => {
      if (queryFailed && q.kind === "detail") throw new Error("详情暂不可用");
      return f.query(q);
    },
    record: async (q) => {
      records.push(q);
      if (first) {
        first = false;
        throw new Error("回执丢失");
      }
      return feedback(q);
    },
  });
  await session.load();
  await session.signal(state.rows[0], "familiar");
  assert.equal(hasPendingPracticeFeedback(state), true);
  queryFailed = true;
  await session.recoverFeedback();
  assert.equal(hasPendingPracticeFeedback(state), false);
  assert.equal(records[0].submissionId, records[1].submissionId);
  assert.equal(f.drafts.get("library:word-list:apple").listAttempts.apple.pending, undefined);
  queryFailed = false;
  assert.equal(await session.restartRound(), true);
  session.dispose();
  f.controller.dispose();
});

for (const scenario of [
  { name: "临摹", mode: "copy", delta: 1 },
  { name: "提示", mode: "recall", signal: "reveal", delta: -1 },
  { name: "列表熟练反馈", mode: "word-list", signal: "familiar", delta: 1 },
  { name: "列表释义揭示", mode: "word-list", signal: "reveal", delta: -1 },
]) {
  test(`${scenario.name}回执后确认草稿失败：不发布教学状态，原身份重试只计一次`, async () => {
    const f = fixture({
      state: createPracticeState("library", scenario.mode),
    });
    const ledger = new Map(),
      calls = [],
      publishes = [],
      errors = [];
    let failConfirmed = true,
      failedSaves = 0,
      score = 10;
    // 使用真实工作区控制器验证回调失败会阻止状态发布；仅 API 适配器注入保存故障。
    const workspaceController = createWorkspaceController({
      api: {
        desktopCommand: async (q) => {
          if (q.action === "practiceSave") return saveDraft(q);
          assert.equal(q.action, "practiceRecord");
          calls.push(structuredClone(q));
          // 原 ID 重放恢复同一回执；测试不能把第二次调用当成第二次得分。
          if (!ledger.has(q.submissionId)) {
            score += scenario.delta;
            ledger.set(q.submissionId, {
              ...feedback(q, scenario.signal !== "reveal"),
              delta: scenario.delta,
            });
          }
          return { practiceFeedback: ledger.get(q.submissionId) };
        },
      },
      publish: (patch) => {
        if (patch.state) publishes.push(patch.state);
        if (patch.error) errors.push(patch.error);
      },
    });
    const session = createPracticeSession({
      state: f.state,
      query: f.query,
      save: saveDraft,
      record: (q, confirmed) => workspaceController.practiceFeedback(q, confirmed),
      workspace: () => f.workspace,
    });
    // 草稿写入不能排进正在等待确认回调的工作区队列，沿用生产中的独立 API 请求。
    async function saveDraft(q) {
      const list = q.draft.listAttempts.apple;
      const confirmed =
        q.draft.answered === true ||
        q.draft.assisted ||
        q.draft.repeatDone > 0 ||
        list?.finished ||
        list?.revealed;
      if (failConfirmed && confirmed) {
        failedSaves++;
        throw new Error("确认草稿写入失败");
      }
      await f.save(q);
      return {};
    }
    await session.load();
    f.state.autoNext = false;
    // 同时覆盖确认时清空输入/增加重复次数后，还原确认前草稿的情况。
    if (scenario.mode === "copy") {
      f.state.repeat = 2;
      session.typing("apple");
      assert.equal(await session.submit(), false);
      assert.equal(f.state.input, "apple");
      assert.equal(f.state.repeatDone, 0);
    } else if (scenario.mode === "recall") await session.hint();
    else {
      const originalAttempt = f.state.listAttempts.apple;
      assert.equal(await session.signal(f.state.rows[0], scenario.signal), false);
      assert.equal(f.state.listAttempts.apple, originalAttempt);
      assert.equal(originalAttempt.finished, undefined);
      assert.equal(originalAttempt.revealed, undefined);
    }
    assert.equal(failedSaves, 1);
    assert.equal(publishes.length, 0);
    assert.equal(hasPendingPracticeFeedback(f.state), true);
    assert.ok(errors.some((error) => /练习结果已确认.*草稿/.test(error)));
    assert.match(f.state.error, /练习结果已确认.*草稿/);
    assert.equal(score, 10 + scenario.delta);
    const original = calls[0];
    const stored = f.drafts.get(`library:${scenario.mode}:apple`);
    if (scenario.mode === "copy") assert.equal(stored.pendingSubmission.id, original.submissionId);
    else if (scenario.mode === "recall") {
      assert.equal(stored.hintSubmissionId, original.submissionId);
      assert.equal(f.state.assisted, false);
      assert.equal(f.state.hintReadPending, false);
    } else assert.equal(stored.listAttempts.apple.pending.submissionId, original.submissionId);
    assert.equal(await session.restartRound(), false);
    failConfirmed = false;
    assert.equal(await session.recoverFeedback(), true);
    assert.equal(publishes.length, 1);
    assert.equal(hasPendingPracticeFeedback(f.state), false);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], original);
    assert.equal(ledger.size, 1);
    assert.equal(score, 10 + scenario.delta);
    if (scenario.mode === "copy") {
      assert.equal(f.state.repeatDone, 1);
      assert.equal(f.state.input, "");
    } else if (scenario.mode === "recall") {
      assert.equal(f.state.assisted, true);
      assert.equal(f.state.hintReadPending, false);
      assert.equal(f.state.input, "");
    } else
      assert.equal(
        scenario.signal === "reveal"
          ? f.state.listAttempts.apple.revealed
          : f.state.listAttempts.apple.finished,
        scenario.signal === "reveal" ? true : scenario.signal,
      );
    session.dispose();
    await session.persist();
    workspaceController.dispose();
    f.controller.dispose();
  });
}

test("提示确认后题目刷新失败仍可重开，其他模式的列表草稿不阻塞临摹", async () => {
  const f = fixture({ state: createPracticeState("library", "recall") });
  let fail = false;
  const session = createPracticeSession({
    state: f.state,
    workspace: () => f.workspace,
    save: f.save,
    query: async (q) => {
      if (fail && q.kind === "practiceQuestion") throw new Error("题目刷新失败");
      return f.query(q);
    },
    record: async (q) => feedback(q),
  });
  await session.load();
  fail = true;
  await session.hint();
  assert.equal(f.state.assisted, true);
  assert.equal(hasPendingPracticeFeedback(f.state), false);
  fail = false;
  assert.equal(await session.restartRound(), true);
  f.state.listAttempts = { old: { pending: { submissionId: "old" } } };
  assert.equal(hasPendingPracticeFeedback(f.state), false);
  await session.switchMode("copy");
  assert.deepEqual(f.state.listAttempts, {});
  session.dispose();
  f.controller.dispose();
});

test("提示已确认但读取失败时，只读原题恢复答案，不重复扣分", async () => {
  for (const mode of ["recall", "meaning-choice"]) {
    const f = fixture({ state: createPracticeState("library", mode) });
    let rejectRead = false;
    const reads = [],
      writes = [];
    const session = createPracticeSession({
      state: f.state,
      workspace: () => f.workspace,
      save: f.save,
      query: async (q) => {
        if (q.kind === "practiceQuestion") {
          reads.push({ ...q });
          if (rejectRead) throw new Error("读取临时断开");
        }
        return f.query(q);
      },
      record: async (q) => {
        writes.push({ ...q });
        return feedback(q);
      },
    });
    await session.load();
    const attempt = f.state.attemptId;
    rejectRead = true;
    await session.hint();
    assert.equal(f.state.assisted, true);
    assert.equal(f.state.hintReadPending, true);
    assert.equal(hasPendingPracticeFeedback(f.state), false);
    assert.equal(f.drafts.get(`library:${mode}:apple`).hintReadPending, true);
    assert.equal(await session.recoverFeedback(), false);
    rejectRead = false;
    assert.equal(await session.recoverFeedback(), true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].signal, "reveal");
    assert.ok(reads.every((q) => q.attemptId === attempt));
    assert.equal(f.state.hintReadPending, false);
    assert.equal(f.state.input, mode === "recall" ? "" : "choice-B");
    assert.equal(f.state.error, "");
    session.dispose();
    f.controller.dispose();
  }
});

test("重启恢复已扣分的提示草稿或详情失败，均不再次提交扣分", async () => {
  const f = fixture({
    state: createPracticeState("library", "meaning-choice"),
  });
  f.drafts.set("library:meaning-choice:apple", {
    attemptId: "original-hint-attempt",
    hintSubmissionId: "hint-event",
    assisted: true,
    hintReadPending: true,
    input: "",
  });
  await f.controller.load();
  assert.equal(f.state.input, "choice-B");
  assert.equal(f.state.hintReadPending, false);
  assert.equal(f.records.length, 0);
  assert.equal(f.state.attemptId, "original-hint-attempt");
  await f.controller.restartRound();
  let failDetail = false;
  const writes = [];
  const session = createPracticeSession({
    state: f.state,
    workspace: () => f.workspace,
    save: f.save,
    query: async (q) => {
      if (failDetail && q.kind === "detail") throw new Error("详情断开");
      return f.query(q);
    },
    record: async (q) => {
      writes.push(q);
      return feedback(q);
    },
  });
  await session.load();
  failDetail = true;
  await session.hint();
  assert.equal(f.state.input, "choice-B");
  assert.equal(f.state.hintReadPending, false);
  assert.match(f.state.error, /提示已显示/);
  assert.equal(writes.length, 1);
  assert.equal(f.drafts.get("library:meaning-choice:apple").hintReadPending, false);
  session.dispose();
  f.controller.dispose();
});

test("自动换到不适用题目显示新词和下一词，不保留上一题的已正确输入", async () => {
  const f = fixture({
    state: createPracticeState("library", "meaning-choice"),
  });
  const session = createPracticeSession({
    state: f.state,
    workspace: () => f.workspace,
    save: f.save,
    record: async (q) => feedback(q),
    query: async (q) =>
      q.kind === "practiceQuestion" && q.wordId === "banana"
        ? {
            wordId: "banana",
            word: "banana",
            meaning: "",
            unavailable: true,
            reason: "词条没有真实释义",
            options: [],
          }
        : f.query(q),
  });
  await session.load();
  session.typing("choice-A");
  await session.submit();
  await session.next();
  assert.equal(f.state.word.id, "banana");
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.questionUnavailable, true);
  assert.equal(f.state.input, "");
  assert.equal(f.state.answered, null);
  assert.equal(await session.submit(), false);
  assert.equal(await session.next(), true);
  assert.equal(f.state.word.id, "cherry");
  assert.equal(f.state.questionUnavailable, false);
  session.dispose();
  f.controller.dispose();
});

test("未知列表回执跨天恢复仍重发原事件，确认后才刷新日期", async () => {
  const records = [];
  const f = fixture({
    record: async (q) => {
      records.push(q);
      if (records.length === 1) throw new Error("已写入但回执丢失");
      return feedback(q);
    },
  });
  await f.controller.load();
  await f.controller.signal(f.state.rows[0], "familiar");
  f.workspace.today = "2026-10-02";
  await f.controller.refreshScope();
  assert.equal(hasPendingPracticeFeedback(f.state), true);
  await f.controller.recoverFeedback();
  assert.equal(records.length, 2);
  assert.equal(records[1].attemptId, records[0].attemptId);
  assert.equal(records[1].submissionId, records[0].submissionId);
  assert.equal(hasPendingPracticeFeedback(f.state), false);
  assert.ok(
    f.saves.some(
      (p) =>
        p.draft.listAttempts.apple?.day === "2026-10-01" &&
        p.draft.listAttempts.apple?.finished === "familiar",
    ),
  );
  f.controller.dispose();
});

test("隔夜重新进入列表不丢失已落盘的未知回执身份", async () => {
  let original;
  const before = fixture({
    record: async (q) => {
      original = q;
      throw new Error("回执丢失");
    },
  });
  await before.controller.load();
  await before.controller.signal(before.state.rows[0], "familiar");
  before.controller.dispose();
  await before.controller.persist();
  const after = fixture();
  after.workspace.today = "2026-10-02";
  after.drafts.set("library:word-list:apple", before.drafts.get("library:word-list:apple"));
  await after.controller.load();
  assert.equal(hasPendingPracticeFeedback(after.state), true);
  assert.equal(after.state.listAttempts.apple.pending.submissionId, original.submissionId);
  assert.equal(await after.controller.recoverFeedback(), true);
  assert.equal(after.records.length, 1);
  assert.equal(after.records[0].attemptId, original.attemptId);
  assert.equal(after.records[0].submissionId, original.submissionId);
  after.controller.dispose();
});

test("补全真实释义后重新出题可恢复练习，不能沿用不适用标记", async () => {
  const f = fixture({
    state: createPracticeState("library", "meaning-choice"),
  });
  let unavailable = true;
  const session = createPracticeSession({
    state: f.state,
    workspace: () => f.workspace,
    save: f.save,
    record: async (q) => feedback(q),
    query: async (q) =>
      q.kind === "practiceQuestion" && unavailable
        ? {
            wordId: q.wordId,
            word: q.wordId,
            meaning: "",
            unavailable: true,
            reason: "暂无真实释义",
            options: [],
          }
        : f.query(q),
  });
  await session.load();
  assert.equal(f.state.questionUnavailable, true);
  unavailable = false;
  await session.retry();
  assert.equal(f.state.questionUnavailable, false);
  assert.equal(f.state.error, "");
  session.typing("choice-A");
  assert.equal(await session.submit(), true);
  session.dispose();
  f.controller.dispose();
});

test("重开保留范围和模式，回到首词并更换答题身份，不撤销已记录反馈", async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.signal(f.words[0], "familiar");
  const oldListId = f.state.listAttempts.apple.id;
  await f.controller.restartRound();
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.listAttempts.apple.finished, undefined);
  assert.notEqual(f.state.listAttempts.apple.id, oldListId);
  assert.equal(f.records.length, 1);
  await f.controller.switchMode("copy");
  await f.controller.next();
  const oldId = f.state.attemptId;
  f.controller.typing("ba");
  await f.controller.restartRound();
  assert.equal(f.state.mode, "copy");
  assert.equal(f.state.range, "library");
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.input, "");
  assert.notEqual(f.state.attemptId, oldId);
  assert.equal(f.records.length, 1);
  f.controller.dispose();
});
test("未确认的提交不能通过重新开始丢失原事件，重试仍使用原ID", async () => {
  let fail = true;
  const f = fixture({
    record: async (q) => {
      if (fail) throw new Error("ACK 未确认");
      return feedback(q);
    },
  });
  await f.controller.load();
  await f.controller.switchMode("copy");
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), false);
  const pending = { ...f.state.pendingSubmission };
  assert.equal(await f.controller.switchMode("recall"), false);
  assert.equal(await f.controller.next(), false);
  assert.equal(await f.controller.switchRange("dictionary"), false);
  assert.equal(await f.controller.retry(), false);
  f.controller.typing("another-answer");
  assert.equal(f.state.input, pending.answer);
  assert.equal(await f.controller.restartRound(), false);
  assert.deepEqual(f.state.pendingSubmission, pending);
  fail = false;
  assert.equal(await f.controller.submit(), true);
  assert.equal(await f.controller.restartRound(), true);
  f.controller.dispose();
});
test("列表与揭示回复丢失时也不能重开，重试后只保留同一次反馈身份", async () => {
  const recorded = [];
  let fail = true;
  const f = fixture({
    record: async (q) => {
      recorded.push(q);
      if (fail) throw new Error("已提交但 ACK 丢失");
      return feedback(q);
    },
  });
  await f.controller.load();
  assert.equal(await f.controller.signal(f.words[0], "familiar"), false);
  const original = { ...f.state.listAttempts.apple.pending };
  assert.equal(await f.controller.restartRound(), false);
  assert.deepEqual(f.state.listAttempts.apple.pending, original);
  fail = false;
  await f.controller.signal(f.words[0], "familiar");
  assert.equal(recorded[0].submissionId, recorded[1].submissionId);
  assert.equal(await f.controller.restartRound(), true);
  await f.controller.switchMode("recall");
  fail = true;
  await f.controller.hint();
  const hintId = f.state.hintSubmissionId;
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), false);
  assert.equal(await f.controller.restartRound(), false);
  assert.equal(f.state.hintSubmissionId, hintId);
  fail = false;
  await f.controller.hint();
  assert.equal(recorded.at(-1).submissionId, hintId);
  assert.equal(f.state.assisted, true);
  assert.equal(await f.controller.restartRound(), true);
  f.controller.dispose();
});
test("列表反馈定位到同一单词，模式独立草稿往返保留", async () => {
  const f = fixture();
  await f.controller.load({ resume: true });
  await f.controller.signal(f.words[2], "familiar");
  assert.equal(f.state.cursor, 2);
  assert.equal(f.records[0].signal, "familiar");
  await f.controller.switchMode("copy");
  assert.equal(f.state.word.word, "apple");
  await f.controller.next();
  f.controller.typing("ba");
  await f.controller.switchMode("recall");
  assert.equal(f.state.word.word, "apple");
  f.controller.typing("a");
  await f.controller.switchMode("copy");
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.input, "ba");
  assert.equal(f.records.length, 1);
  await f.controller.switchMode("recall");
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.input, "a");
  f.controller.dispose();
});

test("六模式分别恢复游标、输入和列表已完成反馈，重开只清当前模式", async () => {
  const f = fixture();
  await f.controller.load({ resume: true });
  await f.controller.signal(f.words[2], "familiar");
  const listAttempt = f.state.listAttempts.cherry.id;
  for (const [mode, cursor, draft] of [
    ["copy", 1, "ba"],
    ["recall", 2, "ch"],
    ["listening", 1, "ban"],
    ["cloze", 2, "che"],
    ["meaning-choice", 1, "choice-B"],
  ]) {
    await f.controller.switchMode(mode);
    assert.equal(f.state.cursor, 0, `${mode}首次从首词开始`);
    await f.controller.next(cursor);
    f.controller.typing(draft);
  }
  await f.controller.switchMode("copy");
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.input, "ba");
  await f.controller.restartRound();
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.input, "");
  for (const [mode, cursor, draft] of [
    ["recall", 2, "ch"],
    ["listening", 1, "ban"],
    ["cloze", 2, "che"],
    ["meaning-choice", 1, "choice-B"],
  ]) {
    await f.controller.switchMode(mode);
    assert.equal(f.state.cursor, cursor, `${mode}的游标不受临摹重开影响`);
    assert.equal(f.state.input, draft, `${mode}的草稿不受临摹重开影响`);
  }
  await f.controller.switchMode("word-list");
  assert.equal(f.state.cursor, 2);
  assert.equal(f.state.listAttempts.cherry.finished, "familiar");
  assert.equal(f.state.listAttempts.cherry.id, listAttempt);
  assert.equal(f.records.length, 1);
  f.controller.dispose();
});

test("重开当前模式刷新新增采集词，其余模式仍沿用原队列及草稿", async () => {
  const f = fixture();
  const reads = [];
  const session = createPracticeSession({
    state: f.state,
    query: async (q) => {
      reads.push(q);
      return f.query(q);
    },
    save: f.save,
    record: async (q) => feedback(q),
    workspace: () => f.workspace,
  });
  await session.load();
  await session.signal(f.words[1], "familiar");
  await session.switchMode("copy");
  await session.next(2);
  session.typing("che");
  await session.switchMode("listening");
  await session.next();
  session.typing("ba");
  f.words.push({ id: "dolphin", word: "dolphin" });
  await session.switchMode("copy");
  assert.equal(f.state.total, 3);
  await session.restartRound();
  assert.equal(f.state.total, 4);
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.input, "");
  await session.next(3);
  assert.equal(f.state.word.id, "dolphin");
  await session.switchMode("listening");
  assert.equal(f.state.total, 3);
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.input, "ba");
  await session.switchMode("word-list");
  assert.equal(f.state.total, 3);
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.rows.length, 3);
  assert.equal(f.state.listAttempts.banana.finished, "familiar");
  assert.ok(reads.filter((q) => q.kind === "practiceWords").every((q) => q.mode));
  session.dispose();
  f.controller.dispose();
});

test("重新进入恢复最后使用方式及该方式游标，换范围仍保持当前方式", async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.signal(f.words[1], "familiar");
  await f.controller.switchMode("copy");
  await f.controller.next(2);
  f.controller.typing("ch");
  await f.controller.persist();
  f.controller.dispose();
  // 通过保存的输入验证重建会话后的行为，而非只检查内存中的状态映射。
  const state = createPracticeState();
  const session = createPracticeSession({
    state,
    query: f.query,
    save: f.save,
    record: async (q) => feedback(q),
    workspace: () => f.workspace,
  });
  await session.load({ resume: true });
  assert.equal(state.mode, "copy");
  assert.equal(state.cursor, 2);
  assert.equal(state.input, "ch");
  await session.switchRange("dictionary");
  assert.equal(state.mode, "copy");
  assert.equal(state.cursor, 0);
  await session.switchRange("library");
  assert.equal(state.cursor, 2);
  assert.equal(state.input, "ch");
  await session.switchMode("word-list");
  assert.equal(state.cursor, 1);
  assert.equal(state.listAttempts.banana.finished, "familiar");
  session.dispose();
});

for (const mode of ["listening", "recall", "cloze"]) {
  test(`${mode}提示只揭示答案，保留可编辑草稿，不自动替用户填入或提交`, async () => {
    const f = fixture({ state: createPracticeState("library", mode) });
    await f.controller.load();
    f.controller.typing("ap");
    const attempt = f.state.attemptId;
    await f.controller.hint();
    assert.equal(f.state.assisted, true);
    assert.equal(f.state.input, "ap");
    assert.equal(f.state.answered, null);
    assert.equal(f.state.question.word, "apple");
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0].signal, "reveal");
    f.controller.typing("app");
    assert.equal(f.state.input, "app");
    await f.controller.switchMode("copy");
    await f.controller.switchMode(mode);
    assert.equal(f.state.assisted, true);
    assert.equal(f.state.input, "app");
    assert.equal(f.state.attemptId, attempt);
    f.controller.typing("apple");
    assert.equal(await f.controller.submit(), true);
    assert.equal(f.records.length, 2);
    assert.equal(f.records[1].attemptId, attempt);
    f.controller.dispose();
  });
}

test("换词先锁定再等待保存；连击不越过一个词，保存失败留在原处", async () => {
  let gate,
    fail = false;
  const f = fixture({
    save: async () => {
      if (fail) throw new Error("磁盘忙");
      if (gate) await gate.promise;
    },
  });
  await f.controller.load();
  await f.controller.switchMode("copy");
  f.controller.typing("ap");
  gate = deferred();
  const first = f.controller.next();
  assert.equal(f.state.transitioning, true);
  assert.equal(await f.controller.next(), false);
  assert.equal(await f.controller.switchMode("recall"), false);
  gate.resolve();
  await first;
  gate = null;
  assert.equal(f.state.cursor, 1);
  f.controller.typing("ba");
  fail = true;
  assert.equal(await f.controller.switchMode("recall"), false);
  assert.equal(f.state.mode, "copy");
  assert.equal(f.state.input, "ba");
  assert.match(f.state.error, /草稿未保存/);
  fail = false;
  f.controller.dispose();
});

test("默认自动继续，重复提交只有一次事实；辅助标记留在同次答题", async () => {
  const pending = deferred(),
    facts = [];
  const f = fixture({
    record: async (q) => {
      facts.push(q);
      if (q.signal !== "reveal") await pending.promise;
      return feedback(q);
    },
  });
  await f.controller.load();
  await f.controller.switchMode("recall");
  await f.controller.hint();
  assert.equal(f.state.assisted, true);
  f.controller.typing("apple");
  const first = f.controller.submit();
  assert.equal(await f.controller.submit(), false);
  pending.resolve();
  await first;
  assert.equal(f.state.answered, true);
  assert.equal(f.state.autoNext, true);
  assert.equal(f.state.cursor, 0);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].signal, "reveal");
  assert.equal(Object.hasOwn(facts[1], "assisted"), false);
  assert.equal(await f.controller.submit(), false);
  await f.controller.next();
  assert.equal(f.state.cursor, 1);
  f.controller.dispose();
});

// 使用虚拟计时推进真实会话逻辑；不等待墙钟一秒，也不更改电脑时间。
async function settleTransition(state) {
  for (let turn = 0; turn < 30 && (state.loading || state.transitioning); turn++)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.loading || state.transitioning, false);
}

test("确认正确回执后稳定停留一秒；连续提交不跳词、不重复记分", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ack = deferred();
  let recorded = 0;
  const f = fixture({
    state: createPracticeState("library", "meaning-choice"),
    record: async (q) => {
      recorded++;
      await ack.promise;
      return feedback(q);
    },
  });
  await f.controller.load();
  f.controller.typing("choice-A");
  const pending = f.controller.submit();
  t.mock.timers.tick(5000);
  assert.equal(f.state.cursor, 0);
  assert.equal(await f.controller.submit(), false);
  ack.resolve();
  await pending;
  assert.equal(f.state.answered, true);
  assert.equal(recorded, 1);
  t.mock.timers.tick(999);
  assert.equal(f.state.transitioning, false);
  assert.equal(f.state.cursor, 0);
  assert.equal(f.state.answered, true);
  assert.equal(await f.controller.submit(), false);
  t.mock.timers.tick(1);
  await settleTransition(f.state);
  assert.equal(f.state.cursor, 1);
  assert.equal(f.state.answered, null);
  f.controller.dispose();
});

test("切模式恢复已确认题保留一秒继续，完成本轮后再返回仍显示完成", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture({ state: createPracticeState("library", "copy") });
  await f.controller.load();
  f.controller.typing("apple");
  await f.controller.submit();
  await f.controller.switchMode("listening");
  t.mock.timers.tick(2000);
  assert.equal(f.state.cursor, 0);
  await f.controller.switchMode("copy");
  assert.equal(f.state.answered, true);
  t.mock.timers.tick(999);
  assert.equal(f.state.cursor, 0);
  t.mock.timers.tick(1);
  await settleTransition(f.state);
  assert.equal(f.state.cursor, 1);
  assert.equal(f.records.length, 1);
  await f.controller.next();
  f.controller.typing("cherry");
  await f.controller.submit();
  t.mock.timers.tick(1000);
  await settleTransition(f.state);
  assert.equal(f.state.roundComplete, true);
  await f.controller.switchMode("listening");
  await f.controller.switchMode("copy");
  assert.equal(f.state.roundComplete, true);
  t.mock.timers.tick(5000);
  assert.equal(f.state.roundComplete, true);
  assert.equal(f.records.length, 2);
  f.controller.dispose();
});

test("音频等待只认当前题的当前播放，失败/停止和旧题不会阻塞", () => {
  const cue = { cue: 1, wordId: "apple", attemptId: "attempt-A" };
  for (const state of ["loading", "playing", "completing"])
    assert.equal(practiceAudioBusy({ ...cue, state }, "apple", "attempt-A"), true);
  for (const state of ["idle", "failed"])
    assert.equal(practiceAudioBusy({ ...cue, state }, "apple", "attempt-A"), false);
  assert.equal(practiceAudioBusy({ ...cue, state: "playing" }, "banana", "attempt-A"), false);
  assert.equal(practiceAudioBusy({ ...cue, state: "playing" }, "apple", "attempt-B"), false);
  assert.equal(
    practiceAudioBusy(
      { wordId: "apple", attemptId: "attempt-A", state: "playing" },
      "apple",
      "attempt-A",
    ),
    false,
  );
});

for (const terminal of ["idle", "failed", "stop"]) {
  test(`听音确认至少一秒，等待当前播放及完成回执；${terminal}后只推进一次`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let audio;
    const f = fixture({ state: createPracticeState("library", "listening"), audio: () => audio });
    await f.controller.load();
    audio = { state: "loading", cue: 1, wordId: "apple", attemptId: f.state.attemptId };
    f.controller.typing("apple");
    assert.equal(await f.controller.submit(), true);
    t.mock.timers.tick(1000);
    assert.equal(f.state.cursor, 0);
    audio = { ...audio, state: "playing", cue: 2 };
    t.mock.timers.tick(100);
    assert.equal(f.state.cursor, 0);
    audio = { ...audio, state: "completing" };
    t.mock.timers.tick(100);
    assert.equal(f.state.cursor, 0);
    audio = terminal === "stop" ? { state: "idle", word: "" } : { ...audio, state: terminal };
    t.mock.timers.tick(100);
    await settleTransition(f.state);
    assert.equal(f.state.cursor, 1);
    t.mock.timers.tick(5000);
    await settleTransition(f.state);
    assert.equal(f.state.cursor, 1);
    assert.equal(f.records.length, 1);
    f.controller.dispose();
  });
}

test("音频挂起有等待上限；旧题的发音不延长下一题反馈期", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let audio;
  const f = fixture({ state: createPracticeState("library", "listening"), audio: () => audio });
  await f.controller.load();
  audio = { state: "playing", cue: 1, wordId: "apple", attemptId: f.state.attemptId };
  f.controller.typing("apple");
  await f.controller.submit();
  t.mock.timers.tick(1000);
  assert.equal(f.state.cursor, 0);
  t.mock.timers.tick(PRACTICE_AUDIO_WAIT_LIMIT_MS);
  await settleTransition(f.state);
  assert.equal(f.state.cursor, 1);
  f.controller.typing("banana");
  await f.controller.submit();
  t.mock.timers.tick(1000);
  await settleTransition(f.state);
  assert.equal(f.state.cursor, 2);
  assert.equal(f.records.length, 2);
  f.controller.dispose();
});

for (const action of ["switch-mode", "restart", "dispose"]) {
  test(`当前发音等待中${action}撤销旧定时器，音频迟到结束不跳新题`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    let audio;
    const f = fixture({ state: createPracticeState("library", "listening"), audio: () => audio });
    await f.controller.load();
    audio = { state: "playing", cue: 1, wordId: "apple", attemptId: f.state.attemptId };
    f.controller.typing("apple");
    await f.controller.submit();
    t.mock.timers.tick(1000);
    assert.equal(f.state.cursor, 0);
    if (action === "switch-mode") await f.controller.switchMode("copy");
    else if (action === "restart") await f.controller.restartRound();
    else f.controller.dispose();
    audio = { ...audio, state: "idle" };
    t.mock.timers.tick(5000);
    await settleTransition(f.state);
    assert.equal(f.state.cursor, 0);
    assert.equal(f.records.length, 1);
    f.controller.dispose();
  });
}

for (const action of ["switch-mode", "restart", "switch-range", "dispose", "disable-auto-next"]) {
  test(`一秒反馈期间${action}取消旧推进，不把后来页面跳到第二词`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const f = fixture({ state: createPracticeState("library", "copy") });
    await f.controller.load();
    f.controller.typing("apple");
    assert.equal(await f.controller.submit(), true);
    t.mock.timers.tick(100);
    if (action === "switch-mode") await f.controller.switchMode("recall");
    else if (action === "restart") await f.controller.restartRound();
    else if (action === "switch-range") await f.controller.switchRange("dictionary");
    else if (action === "dispose") f.controller.dispose();
    else f.state.autoNext = false;
    t.mock.timers.tick(3000);
    await settleTransition(f.state);
    assert.equal(f.state.cursor, 0);
    assert.equal(f.records.length, 1);
    f.controller.dispose();
  });
}

test("错误或未知回执没有自动推进计时，确认草稿失败保留恢复入口", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const response of ["wrong", "unknown", "draft-failure"]) {
    let f;
    f = fixture({
      state: createPracticeState("library", "meaning-choice"),
      record: async (q) => (response === "unknown" ? false : feedback(q, response !== "wrong")),
      save: async (q) => {
        if (response === "draft-failure" && q.draft.answered === true)
          throw new Error("确认草稿保存失败");
      },
    });
    await f.controller.load();
    f.controller.typing("choice-A");
    await f.controller.submit();
    t.mock.timers.tick(5000);
    await settleTransition(f.state);
    assert.equal(f.state.cursor, 0);
    assert.equal(hasPendingPracticeFeedback(f.state), response !== "wrong");
    f.controller.dispose();
  }
});

test("请求失败保留当前答案，销毁后的晚到响应不回写", async () => {
  const f = fixture({
    record: async () => {
      throw new Error("服务暂不可用");
    },
  });
  await f.controller.load();
  await f.controller.switchMode("recall");
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), false);
  assert.equal(f.state.input, "apple");
  assert.equal(f.state.submitting, false);
  const gate = deferred(),
    state = createPracticeState();
  const late = createPracticeSession({
    state,
    workspace: () => f.workspace,
    query: () => gate.promise,
    save: f.save,
    record: async () => true,
  });
  const loading = late.load();
  late.dispose();
  gate.resolve({ cursor: 2 });
  await loading;
  assert.equal(state.word, null);
  assert.equal(state.cursor, 0);
  f.controller.dispose();
});

test("目标切换时旧范围草稿使用旧 scope；空目标不制造公共词条", async () => {
  const f = fixture();
  await f.controller.load();
  await f.controller.switchMode("recall");
  f.controller.typing("personal draft");
  await f.controller.switchRange("goal");
  assert.equal(f.state.total, 0);
  assert.equal(f.state.word, null);
  assert.equal(f.drafts.get("library:recall:apple").input, "personal draft");
  await f.controller.switchRange("library");
  assert.equal(f.state.input, "personal draft");
  f.controller.dispose();
});

test("提交期间目标变化会等待事实保存，随后载入新范围", async () => {
  const gate = deferred(),
    reloaded = deferred();
  let ready = 0;
  const f = fixture({
    state: createPracticeState("goal", "recall"),
    record: async (q) => {
      await gate.promise;
      return feedback(q);
    },
    onReady: (play) => {
      if (play !== false && ++ready === 2) reloaded.resolve();
    },
  });
  f.workspace.profile.goal = "first-catalog";
  await f.controller.load();
  f.controller.typing("apple");
  const submitted = f.controller.submit();
  f.workspace.profile.goal = "second-catalog";
  await f.controller.refreshScope();
  assert.equal(f.state.submitting, true);
  gate.resolve();
  await submitted;
  await reloaded.promise;
  assert.equal(f.drafts.get("goal:first-catalog:recall:apple").answered, true);
  assert.equal(f.state.input, "");
  assert.equal(f.state.answered, null);
  assert.equal(f.state.mode, "recall");
  assert.ok(f.drafts.has("goal:second-catalog:recall:apple"));
  f.controller.dispose();
});

test("答题回执丢失后重试沿用落盘事件 ID，订正保留同一道题身份", async () => {
  const sent = [];
  const f = fixture({
    record: async (value) => {
      sent.push(value);
      return sent.length > 1 ? feedback(value) : false;
    },
  });
  await f.controller.load();
  await f.controller.switchMode("recall");
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), false);
  const draft = f.saves.at(-1).draft;
  assert.equal(draft.pendingSubmission.id, sent[0].submissionId);
  assert.equal(await f.controller.submit(), true);
  assert.equal(sent[1].submissionId, sent[0].submissionId);
  assert.equal(sent[1].attemptId, sent[0].attemptId);
  assert.equal(f.saves.at(-1).draft.pendingSubmission, null);
  f.controller.dispose();
});

test("教学重进已完成临摹可再次输入，普通练习仍保留完成草稿", async () => {
  const f = fixture({
    state: createPracticeState("library", "copy"),
    lockInitialMode: true,
  });
  f.drafts.set("library:copy:apple", {
    input: "apple",
    answered: true,
    attemptId: "previous",
  });
  await f.controller.load({ resume: true });
  assert.equal(f.state.answered, null);
  assert.equal(f.state.input, "");
  assert.notEqual(f.state.attemptId, "previous");
  f.controller.typing("a");
  assert.equal(f.state.input, "a");
  f.controller.dispose();
  const normal = fixture({ state: createPracticeState("library", "copy") });
  normal.drafts.set("library:copy:apple", {
    input: "apple",
    answered: true,
    attemptId: "previous",
  });
  await normal.controller.load();
  assert.equal(normal.state.answered, true);
  assert.equal(normal.state.attemptId, "previous");
  normal.controller.dispose();
});

test("选项身份不等于单词ID，显示反馈以核心判题为准", async () => {
  const f = fixture({
    state: createPracticeState("library", "meaning-choice"),
    record: async (q) => feedback(q, false),
  });
  await f.controller.load();
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), true);
  assert.equal(f.state.answered, false);
  assert.notEqual(f.state.choices[0].id, f.state.word.id);
  await f.controller.hint();
  assert.equal(f.state.input, "choice-B");
  assert.equal(f.state.question.context, "Frozen _____ context");
  f.controller.dispose();
});

test("缺失或错配回执不能解锁答题，重试保留提交身份", async () => {
  const f = fixture({
    state: createPracticeState("library", "copy"),
    record: async (q) => ({ ...feedback(q), submissionId: "another" }),
  });
  await f.controller.load();
  f.controller.typing("apple");
  assert.equal(await f.controller.submit(), false);
  assert.equal(f.state.answered, null);
  assert.ok(f.state.pendingSubmission.id);
  assert.match(f.state.error, /回执不匹配/);
  f.controller.dispose();
});

test("列表显示前冻结每一道题，后续资料刷新保持当时释义", async () => {
  const f = fixture();
  const requested = [];
  const query = async (q) => {
    requested.push(q);
    return f.query(q);
  };
  const state = createPracticeState();
  const session = createPracticeSession({
    state,
    query,
    save: f.save,
    record: async (q) => feedback(q),
    workspace: () => f.workspace,
  });
  await session.load();
  assert.equal(requested.filter((q) => q.kind === "practiceQuestion").length, 3);
  assert.deepEqual(
    requested.filter((q) => q.kind === "practiceQuestion").map((q) => q.cursor),
    [0, 1, 2],
  );
  assert.ok(requested.some((q) => q.kind === "practiceWords"));
  assert.equal(state.rows[1].meaning, "冻结释义");
  await session.signal(state.rows[1], "familiar");
  assert.equal(state.rows[1].meaning, "冻结释义");
  session.dispose();
  f.controller.dispose();
});
