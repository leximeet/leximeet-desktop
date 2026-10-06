<script setup>
import { computed, ref, reactive, toRefs, watch, onBeforeUnmount, nextTick } from "vue";
import { api } from "../lib/api.js";
import SpellingInput from "./SpellingInput.vue";
import { createPracticeAudio } from "../lib/practice-audio.js";
import Icon from "../components/Icon.vue";
import { currentGuideStep } from "./guide-steps.js";
import {
  PRACTICE_MODES as modes,
  createPracticeState,
  createPracticeSession,
  hasPendingPracticeFeedback,
} from "./practice-session.js";
const sounds = createPracticeAudio();
const props = defineProps({
  state: Object,
  recordFeedback: Function,
  speak: Function,
  stopAudio: Function,
  audio: Object,
  initialRange: { type: String, default: "library" },
});
const lesson = currentGuideStep(props.state.guide)?.id;
const model = reactive(
  createPracticeState(
    lesson === "learn" && props.state.queue.tasks.length ? "today" : props.initialRange,
    lesson === "practice" ? "copy" : "word-list",
  ),
);
const {
  range,
  mode,
  cursor,
  total,
  word,
  rows,
  input,
  choices,
  question,
  listAttempts,
  answered,
  roundComplete,
  assisted,
  loading,
  submitting,
  transitioning,
  autoNext,
  repeat,
  error,
  pendingRange,
  questionUnavailable,
} = toRefs(model);
const field = ref(null),
  hidden = ref("meaning"),
  optionsOpen = ref(false);
const pageSize = 12;
// 教学等待当前步骤完成；常规练习答对后自动继续。
model.autoNext = !lesson;
void sounds.prepare().catch(() => {});
const answer = computed(() => word.value?.word || "");
const pendingFeedback = computed(() => hasPendingPracticeFeedback(model));
const pendingHintRead = computed(() => model.hintReadPending);
// pending 是用于幂等恢复的持久标记，不是保存失败。正常等待期间不插入红条推挤题卡。
const recoveryVisible = computed(
  () =>
    !model.loading &&
    !model.submitting &&
    !model.transitioning &&
    !!(model.error || pendingFeedback.value || pendingHintRead.value),
);
// 释义常带英文词头；回忆时一并遮住，避免正文直接泄露答案。
function headwordPattern(value, flags = "gi") {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z])${escaped}(?=$|[^A-Za-z])`, flags);
}
function hiddenMeaning(item) {
  return item.meaning?.replace(headwordPattern(item.word), "$1_____") || "";
}
// 语境与选项属于冻结题目；读取最新资料不能更换已经显示的判题依据。
const cloze = computed(() => question.value?.context || "");

const session = createPracticeSession({
  state: model,
  query: api.desktopQuery,
  save: api.desktopCommand,
  record: props.recordFeedback,
  workspace: () => props.state,
  audio: () => props.audio,
  lockInitialMode: !!lesson,
  onModeChange: () => props.stopAudio?.(),
  onReady: async (play = true) => {
    await nextTick();
    field.value?.focus();
    // 完整输入后可能在 100ms 自动确认前退出；恢复后继续同一提交，不等待再敲一个字。
    if (model.input && model.answered !== true && !model.questionUnavailable) typing(model.input);
    if (play && model.mode === "listening" && model.word) playCurrentWord();
  },
});
// 给当前题发音标记身份，自动换题只等待这一题当前的播放。
function playCurrentWord() {
  if (!model.word) return;
  props.speak(model.word.word, undefined, {
    wordId: model.word.id,
    attemptId: model.attemptId,
  });
}
const {
  switchMode,
  requestRange,
  switchRange,
  signal,
  hint,
  retry,
  next,
  restartRound,
  recoverFeedback,
} = session;
const submit = async () => {
  // 自动反馈期间 Enter 和连续点击也必须等待一秒；手动继续只用于明确关闭自动下一词时。
  if (model.answered === true) return model.autoNext ? false : next();
  const saved = await session.submit();
  if (saved && props.state.settings.practiceResultSoundEnabled)
    sounds.tone(model.answered !== false, props.state.settings.practiceVolume).catch(() => {});
};
let spellingTimer;
// 拼写完整且正确时直接确认；短暂缓冲保留连续键入手感，换词后旧回调不得提交。
function typing(value) {
  clearTimeout(spellingTimer);
  session.typing(value);
  const normalize = (text) => text.normalize("NFKC").trim().toLowerCase();
  if (
    !["copy", "recall"].includes(model.mode) ||
    !value ||
    normalize(value) !== normalize(answer.value)
  )
    return;
  const wordId = model.word?.id,
    currentMode = model.mode;
  spellingTimer = setTimeout(() => {
    if (
      model.word?.id === wordId &&
      model.mode === currentMode &&
      model.input === value &&
      model.answered !== true
    )
      void submit();
  }, 100);
}
async function chooseAnswer(option) {
  if (
    model.submitting ||
    model.transitioning ||
    model.loading ||
    pendingFeedback.value ||
    model.answered === true ||
    !model.choices.some((choice) => choice.id === option.id)
  )
    return;
  session.typing(option.id);
  await submit();
}
function keySound() {
  if (props.state.settings.practiceKeySoundEnabled)
    sounds.click(props.state.settings.practiceVolume).catch(() => {});
}

function toggleMask() {
  hidden.value = hidden.value === "meaning" ? "word" : "meaning";
}
async function reveal(item) {
  await signal(item, "reveal");
}
// 重开当前范围和模式的一轮练习；取消旧输入计时与发音，已保存的学习分数继续保留。
async function restartPractice() {
  clearTimeout(spellingTimer);
  props.stopAudio?.();
  if (await restartRound()) hidden.value = "meaning";
}
const currentAttempt = (item) => {
  const attempt = listAttempts.value[item.id];
  return attempt?.day === props.state.today ? attempt : null;
};
const isRevealed = (item) => currentAttempt(item)?.revealed || currentAttempt(item)?.finished;
const finished = (item) => currentAttempt(item)?.finished;

watch(
  () => [props.state.profile.goal, props.state.today],
  ([goal, day], [previousGoal, previousDay]) => {
    if (
      (range.value === "goal" && goal !== previousGoal) ||
      (range.value === "today" && day !== previousDay)
    )
      session.refreshScope();
  },
);
session.load({ resume: true });
onBeforeUnmount(() => {
  clearTimeout(spellingTimer);
  sounds.dispose();
  session.dispose();
  props.stopAudio?.();
});
</script>
<template>
  <section class="d-page practice-page">
    <header class="page-heading">
      <div>
        <h1>练习中心</h1>
      </div>
      <div class="practice-toolbar">
        <label
          >练习范围<select
            :value="pendingRange || range"
            @change="requestRange($event.target.value)"
            :disabled="loading || submitting || transitioning"
            aria-label="练习范围"
          >
            <option value="library">我的词库</option>
            <option value="goal">当前学习目标</option>
            <option value="today">今日任务</option>
            <option value="dictionary">整本词典</option>
            <option
              v-for="book in state.books.filter((item) => !item.role)"
              :key="book.id"
              :value="`book:${book.id}`"
            >
              {{ book.name }}
            </option>
          </select></label
        ><button
          class="button small"
          :disabled="
            loading || submitting || transitioning || !!pendingRange || pendingFeedback || !word
          "
          :title="
            pendingFeedback
              ? '请先重试尚未确认的练习反馈'
              : '从当前范围的第一词开始，保留已记录分数'
          "
          @click="restartPractice"
        >
          <Icon name="refresh" />重新开始</button
        ><button
          v-if="mode !== 'word-list'"
          class="text-button"
          :aria-expanded="optionsOpen"
          @click="optionsOpen = !optionsOpen"
        >
          <Icon name="adjustments-horizontal" />练习设置
        </button>
      </div>
    </header>
    <div class="practice-options" v-if="optionsOpen && mode !== 'word-list'">
      <label
        >重复次数<input
          type="number"
          min="1"
          max="10"
          v-model.number="repeat"
          aria-label="重复次数" /></label
      ><label class="inline-check"
        ><input type="checkbox" v-model="autoNext" />自动进入下一词</label
      >
    </div>
    <div
      v-if="pendingRange"
      class="practice-range-confirm"
      role="region"
      aria-label="切换练习范围确认"
    >
      <p>保存当前草稿，再切换范围。</p>
      <div class="row">
        <button class="button small primary" @click="switchRange(pendingRange)"> 保存并切换</button
        ><button class="text-button" @click="pendingRange = ''"> 继续当前范围 </button>
      </div>
    </div>
    <div class="mode-tabs" role="tablist" aria-label="练习方式">
      <button
        v-for="item in modes"
        :key="item[0]"
        :class="{ active: mode === item[0] }"
        role="tab"
        :aria-selected="mode === item[0]"
        :disabled="loading || submitting || transitioning || !!pendingRange"
        @click="switchMode(item[0])"
      >
        {{ item[1] }}
      </button>
    </div>
    <div
      class="error-banner practice-recovery"
      data-guide="practice-recovery"
      v-if="recoveryVisible"
      role="alert"
    >
      <span>{{ error || "这次反馈尚未确认，请重试保存。" }}</span>
      <button
        v-if="pendingFeedback || pendingHintRead"
        class="button small"
        :disabled="loading || submitting || transitioning"
        @click="recoverFeedback"
      >
        {{ pendingHintRead ? "重新读取提示" : "重试保存" }}
      </button>
    </div>
    <!-- 换题期间保留上一题反馈，准备完新题再一次性替换，避免空白闪动。 -->
    <div v-if="loading && !word" class="empty">正在准备词条…</div>
    <div v-else-if="!word" class="empty" data-guide="practice-empty">
      <Icon name="book-2" />
      <h2>等一个新的遇见</h2>
      <p>记录单词后就能练习，也可以在范围里选择词典。</p>
    </div>
    <section v-else-if="roundComplete" class="empty" aria-live="polite">
      <Icon name="check" />
      <h2>已完成本轮练习</h2>
      <p>可以换一种方式，或再回想一轮。</p>
      <button class="button" @click="restartRound">再练一轮</button>
    </section>
    <section
      v-else-if="mode === 'word-list'"
      class="practice-list-panel"
      data-guide="practice-list"
    >
      <div class="section-heading">
        <p class="muted">{{ total.toLocaleString() }} 词</p>
        <button
          class="button small"
          data-guide="practice-mask"
          :aria-label="hidden === 'meaning' ? '遮挡英文' : '遮挡中文'"
          @click="toggleMask"
        >
          <Icon name="eye-off" />{{ hidden === "meaning" ? "遮挡英文" : "遮挡中文" }}
        </button>
      </div>
      <div class="practice-list-scroll">
        <table class="word-table practice-list-table">
          <thead>
            <tr>
              <th>单词</th>
              <th>中文释义</th>
              <th
                title="初始 10 分；20 完成初学，30 进入熟悉休息期。默写与填空 +2，其余 +1；错误或查看答案 −1。"
              >
                熟练度
              </th>
              <th>记忆反馈</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(item, index) in rows"
              :key="item.id"
              :data-guide="index === 0 ? 'practice-row' : undefined"
              :class="{ selected: item.id === word?.id }"
            >
              <td class="word-column">
                <button
                  v-if="hidden === 'word' && !isRevealed(item)"
                  class="word-mask"
                  @click="reveal(item)"
                  :data-guide="index === 0 ? 'practice-reveal' : undefined"
                  aria-label="揭示英文"
                >
                  点击查看</button
                ><span v-else>{{ item.word }}</span>
              </td>
              <td class="list-meaning">
                <button
                  v-if="hidden === 'meaning' && !isRevealed(item)"
                  class="word-mask"
                  @click="reveal(item)"
                  :data-guide="index === 0 ? 'practice-reveal' : undefined"
                  aria-label="揭示中文"
                >
                  点击查看</button
                ><span v-else>{{ hidden === "word" ? hiddenMeaning(item) : item.meaning }}</span>
              </td>
              <td>
                <span class="familiarity-score">{{
                  (item.familiarity?.score ?? 10) + " / 30"
                }}</span
                ><small
                  v-if="item.familiarity?.familiar || item.familiarity?.unfamiliar"
                  class="signal-count"
                  >{{ item.familiarity.familiar }} 熟 ·
                  {{ item.familiarity.unfamiliar }} 不熟悉</small
                >
              </td>
              <td>
                <div
                  class="list-signals"
                  :data-guide="index === 0 ? 'practice-signals' : undefined"
                >
                  <button
                    class="button small primary"
                    :disabled="submitting || transitioning || !!finished(item)"
                    @click="signal(item, 'familiar')"
                  >
                    熟练 +1</button
                  ><button
                    class="button small"
                    :disabled="submitting || transitioning || !!finished(item)"
                    @click="signal(item, 'unfamiliar')"
                  >
                    不熟悉 −1
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="list-pagination">
        <button
          class="text-button"
          :disabled="loading || submitting || transitioning"
          @click="restartRound"
        >
          新一轮回想
        </button>
        <button
          class="text-button"
          :disabled="cursor < pageSize || loading || submitting || transitioning"
          @click="next(-pageSize)"
        >
          上一页</button
        ><span class="muted"
          >{{ Math.floor(cursor / pageSize) + 1 }} /
          {{ Math.max(1, Math.ceil(total / pageSize)) }}</span
        ><button
          class="text-button"
          :disabled="
            Math.floor(cursor / pageSize) >= Math.ceil(total / pageSize) - 1 ||
            loading ||
            submitting ||
            transitioning
          "
          @click="next(pageSize)"
        >
          下一页
        </button>
      </div>
    </section>
    <section v-else-if="questionUnavailable" class="empty">
      <h2>{{ word.word }}</h2>
      <p>这个词暂不适合当前练习方式。</p>
      <button
        class="button"
        :disabled="cursor + 1 >= total || loading || transitioning"
        @click="next()"
      >
        下一词
      </button>
    </section>
    <div
      v-else
      class="practice-stage"
      :class="{
        correct: answered === true && !submitting,
        incorrect: answered === false && !submitting,
      }"
    >
      <p class="eyebrow">
        {{ cursor + 1 }} / {{ total }} ·
        {{ modes.find((item) => item[0] === mode)[1] }}
      </p>
      <p v-if="mode === 'copy'" class="practice-instruction">
        {{ word.meaning }}
      </p>
      <h2 v-else-if="mode === 'meaning-choice'" class="practice-headword">
        {{ word.word }}
      </h2>
      <h2 v-else-if="mode === 'listening'">
        <button class="button" @click="playCurrentWord"> <Icon name="volume" />再听一次 </button>
      </h2>
      <p v-else-if="mode === 'cloze'" class="practice-question">
        {{ cloze || "这个词暂无例句，可换一种方式练习。" }}
      </p>
      <p v-else class="practice-question">{{ hiddenMeaning(word) }}</p>
      <div v-if="mode === 'meaning-choice'" class="meaning-choices" aria-label="释义选项">
        <button
          v-for="(option, index) in choices"
          :key="option.id"
          class="meaning-choice"
          :class="{
            chosen: input === option.id,
            correct: answered === true && !submitting && input === option.id,
            incorrect: answered === false && !submitting && input === option.id,
          }"
          :disabled="loading || submitting || transitioning || pendingFeedback || answered === true"
          @click="chooseAnswer(option)"
        >
          <span>{{ index + 1 }}</span
          ><strong>{{ option.text }}</strong>
        </button>
        <p v-if="!choices.length" class="muted"> 可区分的释义不足，请换一种方式。 </p>
      </div>
      <form
        v-else-if="mode !== 'cloze' || cloze"
        data-guide="practice-input"
        @submit.prevent="submit"
      >
        <SpellingInput
          ref="field"
          :value="input"
          :answer="answer"
          :copy="mode === 'copy'"
          :hint="assisted"
          :disabled="submitting || transitioning || pendingFeedback"
          :correct="answered === true"
          @update="typing"
          @type="keySound"
          @submit="submit"
        />
        <button
          v-if="answered !== true && !['copy', 'recall'].includes(mode)"
          class="button primary answer-submit"
          type="submit"
          :disabled="submitting || answered === true || !input.trim()"
        >
          确认答案
        </button>
      </form>
      <p class="practice-feedback" aria-live="polite">
        {{
          submitting
            ? "正在保存…"
            : answered === true
              ? `正确 · 已记录${word.familiarity?.lastDelta > 0 ? " +" + word.familiarity.lastDelta : ""}`
              : answered === false
                ? "再回想一下"
                : mode === "meaning-choice"
                  ? "选择释义"
                  : ["copy", "recall"].includes(mode)
                    ? "直接输入，拼对后继续"
                    : "Enter 确认"
        }}
      </p>
      <p class="muted" v-if="assisted" title="查看答案已扣 1 分；本题订正不重复扣分或加分。">
        已用提示 · 本题不加分
      </p>
      <!-- 切换题型的草稿尚在保存时，导航也须锁定；不能显示可点按钮却丢弃点击。 -->
      <div class="row">
        <button
          class="text-button"
          :disabled="cursor === 0 || loading || submitting || transitioning"
          @click="next(-1)"
        >
          上一词</button
        ><button
          v-if="answered !== true && mode !== 'copy'"
          class="text-button"
          :disabled="submitting || transitioning"
          @click="hint"
        >
          提示</button
        ><button
          v-if="answered === true && !autoNext"
          class="text-button"
          :disabled="loading || submitting || transitioning"
          @click="retry"
        >
          再练一次</button
        ><button
          class="text-button"
          v-if="answered !== true || !autoNext || error"
          :class="{ primary: answered === true }"
          :disabled="
            (cursor + 1 >= total && answered !== true) || loading || submitting || transitioning
          "
          @click="next()"
        >
          {{ answered === true ? "熟记" : "下一词" }}
        </button>
      </div>
    </div>
  </section>
</template>
