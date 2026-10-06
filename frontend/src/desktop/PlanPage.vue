<script setup>
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { api } from "../lib/api.js";
import Icon from "../components/Icon.vue";
import PlanDialog from "./PlanDialog.vue";
import LearningForecast from "./LearningForecast.vue";
import { currentGuideStep } from "./guide-steps.js";
const props = defineProps({
  state: Object,
  busy: Boolean,
  run: Function,
  source: String,
});
const emit = defineEmits(["source-used"]);
const dialog = ref(null),
  forecast = ref(null),
  error = ref("");
const profile = computed(() => props.state.profile);
const hasPlan = computed(() => !!profile.value.goal && profile.value.planEnabled);
const lesson = computed(() => currentGuideStep(props.state.guide)?.id);
const name = computed(() =>
  profile.value.goal === "dictionary"
    ? "本地词典"
    : (
        props.state.catalogs.find((c) => c.catalog_id === profile.value.goal)?.title_zh ||
        "学习目标"
      ).replace(/\s*标签/g, ""),
);
function open(adjust = false, source = "") {
  dialog.value = { adjust, source };
}
function close() {
  dialog.value = null;
}
watch(
  lesson,
  (step, old) => {
    if (step === "goal" || step === "plan") {
      if (!dialog.value) open(false);
    } else if (["goal", "plan"].includes(old)) close();
  },
  { immediate: true },
);
watch(
  () => props.source,
  (source) => {
    if (source) {
      open(false, source);
      emit("source-used");
    }
  },
  { immediate: true },
);
let ticket = 0;
async function loadForecast() {
  const id = ++ticket;
  const goal = profile.value.goal;
  // 同目标刷新保留面板，不能在每次保存成绩后先清空图表造成闪屏。
  if (forecast.value?.goal !== goal) forecast.value = null;
  error.value = "";
  if (!goal) return;
  try {
    const value = await api.desktopQuery({
      kind: "planningPreview",
      goal,
      dailyNew: profile.value.dailyNew,
      daysAhead: 7,
    });
    if (id === ticket) forecast.value = { ...value, goal };
  } catch (e) {
    if (id === ticket) error.value = e.message;
  }
}
watch(
  () => [
    profile.value.revision,
    props.state.today,
    props.state.goalProgress.learned,
    props.state.goalProgress.total,
    props.state.queue.newDone,
    props.state.dictionary.edition,
    props.state.insights.trash,
    props.state.insights.practice,
    // 非目标采集也可能占据今日队列；只比较身份，避免轮询快照触发无效重查。
    props.state.queue.tasks
      .filter((task) => task.kind === "new")
      .map((task) => task.id)
      .join(","),
  ],
  loadForecast,
  { immediate: true },
);
onBeforeUnmount(() => ticket++);
</script>
<template>
  <section class="d-page plan-page">
    <header class="page-heading">
      <h1>学习规划</h1>
      <button v-if="hasPlan" class="button" @click="open(true)"> 调整计划 </button>
    </header>
    <div v-if="!hasPlan" class="planning-empty" data-guide="planning-entry">
      <Icon name="book-2" />
      <h2>一个目标，一份清晰的安排。</h2>
      <p>选择想学的词库，安排每天的新学和复习。也可以先记录单词，自由练习。</p>
      <button class="button primary" @click="open(false)">设置学习规划</button>
    </div>
    <template v-else>
      <section class="planning-summary" data-guide="planning-entry">
        <div>
          <p class="eyebrow">当前学习目标</p>
          <h2>{{ name }}</h2>
          <p>
            {{ state.goalProgress.total.toLocaleString() }} 词 · 每天新学 {{ profile.dailyNew }} ·
            每天复习 {{ profile.dailyReview }}
          </p>
          <p class="planning-reminder">
            <Icon name="clock" />{{
              profile.reminderEnabled
                ? `提醒 ${profile.studyStart}–${profile.studyEnd}`
                : "提醒已关闭"
            }}
          </p>
        </div>
        <button class="button" @click="open(false)">更换学习目标</button>
      </section>
      <LearningForecast
        v-if="forecast"
        :forecast="forecast"
        :daily-review="profile.dailyReview"
        :goal="profile.goal"
      />
      <p v-if="error" role="alert" class="forecast-error">
        预测更新失败{{ forecast ? "，当前显示上一次结果" : "" }}：{{ error }}
        <button class="button small" @click="loadForecast">重试预测</button>
      </p>
      <p v-else-if="!forecast" class="muted" role="status">正在准备学习预测…</p>
    </template>
    <PlanDialog
      v-if="dialog"
      :state="state"
      :run="run"
      :adjust="dialog.adjust"
      :source="dialog.source"
      @close="close"
    />
  </section>
</template>
