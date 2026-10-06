<script setup>
import { computed, ref, watch, onBeforeUnmount } from "vue";
import AppDialog from "./AppDialog.vue";
import Icon from "../components/Icon.vue";
import { api } from "../lib/api.js";
import { currentGuideStep, DEFAULT_GUIDE_GOAL } from "./guide-steps.js";
const props = defineProps({
  state: Object,
  run: Function,
  adjust: Boolean,
  source: String,
});
const emit = defineEmits(["close"]);
const original = { ...props.state.profile };
const lesson = computed(() => currentGuideStep(props.state.guide)?.id);
const teaching = computed(() => ["goal", "plan"].includes(lesson.value));
const stage = ref(props.adjust || lesson.value === "plan" ? "schedule" : "target");
const body = ref(null);
const goal = ref(props.source || original.goal || (teaching.value ? DEFAULT_GUIDE_GOAL : ""));
const kind = ref(goal.value === "dictionary" ? "dictionary" : "catalog");
const category = ref("exam"),
  search = ref("");
const dailyNew = ref(original.dailyNew ?? 10);
const dailyReview = ref(original.dailyReview ?? 20);
const reminder = ref(original.reminderEnabled),
  start = ref(original.studyStart),
  end = ref(original.studyEnd);
const busy = ref(false),
  error = ref(""),
  preview = ref(null),
  previewBusy = ref(false);
const title = props.adjust ? "调整学习计划" : original.goal ? "更换学习目标" : "设置学习规划";
const selected = computed(() => (kind.value === "dictionary" ? "dictionary" : goal.value));
const catalogTitle = (title) => (title || "").replace(/\s*标签/g, "");
const targetName = computed(() =>
  selected.value === "dictionary"
    ? `${props.state.dictionary.edition === "full-text" ? "Full" : "Core"} Text`
    : catalogTitle(props.state.catalogs.find((c) => c.catalog_id === selected.value)?.title_zh),
);
const catalogs = computed(() =>
  props.state.catalogs.filter((c) =>
    search.value.trim()
      ? `${c.title_zh} ${c.source}`.toLowerCase().includes(search.value.trim().toLowerCase())
      : c.category === category.value,
  ),
);
const conflict = computed(() => props.state.profile.revision !== original.revision);
const valid = computed(
  () =>
    Number.isInteger(dailyNew.value) &&
    dailyNew.value >= 1 &&
    (dailyNew.value <= 50 || dailyNew.value === original.dailyNew) &&
    Number.isInteger(dailyReview.value) &&
    dailyReview.value >= 0 &&
    dailyReview.value <= 500 &&
    (!reminder.value || (start.value && end.value && start.value < end.value)),
);
let generation = 0;
// 查询候选目标不会写入当前规划；晚到结果不能覆盖后来选择的目标。
watch(
  [selected, dailyNew, () => props.state.profile.revision, () => props.state.today],
  async () => {
    const ticket = ++generation;
    preview.value = null;
    if (
      !selected.value ||
      !Number.isInteger(dailyNew.value) ||
      dailyNew.value < 1 ||
      dailyNew.value > 200
    ) {
      previewBusy.value = false;
      return;
    }
    previewBusy.value = true;
    error.value = "";
    try {
      const value = await api.desktopQuery({
        kind: "planningPreview",
        goal: selected.value,
        dailyNew: dailyNew.value,
      });
      if (ticket === generation) preview.value = value;
    } catch (e) {
      if (ticket === generation) error.value = e.message;
    } finally {
      if (ticket === generation) previewBusy.value = false;
    }
  },
  { immediate: true },
);
watch(lesson, (value) => {
  if (value === "goal") stage.value = "target";
  if (value === "plan") stage.value = "schedule";
});
// 目标列表与计划表单共用滚动区；换步回到顶部，避免沿用列表位置而漏掉新学与目标信息。
watch(
  stage,
  () => {
    if (body.value) body.value.scrollTop = 0;
  },
  { flush: "post" },
);
async function next() {
  if (!selected.value) return;
  if (lesson.value === "goal") await props.run({ action: "guideNext", step: "goal" });
  else stage.value = "schedule";
}
async function previous() {
  if (lesson.value === "plan") await props.run({ action: "guidePrevious" });
  else stage.value = "target";
}
async function save() {
  if (busy.value || conflict.value || !valid.value || !preview.value) return;
  busy.value = true;
  const ok = await props.run({
    action: "savePlanning",
    goal: selected.value,
    dailyNew: dailyNew.value,
    dailyReview: dailyReview.value,
    planEnabled: true,
    reminderEnabled: reminder.value,
    studyStart: reminder.value ? start.value : original.studyStart,
    studyEnd: reminder.value ? end.value : original.studyEnd,
    expectedRevision: original.revision,
  });
  busy.value = false;
  if (ok) emit("close");
  else error.value = "规划未保存，请检查后重试。";
}
onBeforeUnmount(() => generation++);
</script>
<template>
  <AppDialog
    :title="title"
    variant="planning-dialog"
    :teaching="teaching"
    :busy="busy"
    @close="emit('close')"
  >
    <ol v-if="!adjust" class="planning-steps" aria-label="学习规划步骤">
      <li :aria-current="stage === 'target' ? 'step' : undefined"> <span>1</span>选择学习目标 </li>
      <li :aria-current="stage === 'schedule' ? 'step' : undefined">
        <span>2</span>设置学习计划
      </li>
    </ol>
    <div
      ref="body"
      class="planning-body"
      :data-plan-step="stage"
      :data-guide="stage === 'target' ? 'guide-goal-choice' : 'plan-form'"
    >
      <template v-if="stage === 'target'">
        <nav class="mode-tabs" aria-label="学习目标类型">
          <button :class="{ active: kind === 'catalog' }" @click="kind = 'catalog'">
            主题词库
          </button>
          <button :class="{ active: kind === 'dictionary' }" @click="kind = 'dictionary'">
            本地词典
          </button>
        </nav>
        <template v-if="kind === 'catalog'">
          <div class="planning-filter">
            <div class="planning-categories">
              <button :aria-pressed="category === 'exam'" @click="category = 'exam'"> 考试</button
              ><button :aria-pressed="category === 'subject'" @click="category = 'subject'">
                专业
              </button>
            </div>
            <input
              v-model="search"
              type="search"
              aria-label="搜索学习目标"
              placeholder="搜索词库"
            />
          </div>
          <div class="planning-catalogs" role="group" aria-label="学习目标">
            <button
              v-for="item in catalogs"
              :key="item.catalog_id"
              class="planning-catalog"
              :aria-pressed="goal === item.catalog_id"
              @click="goal = item.catalog_id"
            >
              <Icon name="book-2" /><span
                ><strong>{{ catalogTitle(item.title_zh) }}</strong
                ><small>{{ item.entry_count.toLocaleString() }} 词</small></span
              ><Icon v-if="goal === item.catalog_id" name="check" />
            </button>
            <p v-if="!catalogs.length">没有匹配的词库。</p>
          </div>
        </template>
        <div v-else class="planning-dictionary">
          <Icon name="books" />
          <h3>{{ targetName }}</h3>
          <p> {{ state.dictionary.entryCount.toLocaleString() }} 词 · 随当前本地词典更新 </p>
        </div>
      </template>
      <template v-else>
        <div class="planning-selected">
          <Icon name="book-2" /><strong>{{ targetName || "尚未选择目标" }}</strong>
        </div>
        <h3>每天的安排</h3>
        <label class="planning-row"
          ><span>每天新学</span
          ><input
            v-model.number="dailyNew"
            type="number"
            min="1"
            :max="Math.max(50, original.dailyNew)"
            aria-label="每天新学"
          /><span>词</span></label
        >
        <label class="planning-row"
          ><span>每天复习</span
          ><input
            v-model.number="dailyReview"
            type="number"
            min="0"
            max="500"
            aria-label="每天复习"
          /><span>词</span></label
        >
        <label class="planning-row"
          ><span>学习提醒</span><input v-model="reminder" type="checkbox" aria-label="学习提醒"
        /></label>
        <div v-if="reminder" class="planning-row planning-time">
          <span>提醒时间</span>
          <div>
            <input v-model="start" type="time" aria-label="学习开始时间" /><span>至</span
            ><input v-model="end" type="time" aria-label="学习结束时间" />
          </div>
        </div>
        <p v-if="!valid" role="alert">
          新学为 1–50 词，复习为 0–500 词；开启提醒时，结束时间须晚于开始时间。
          <template v-if="original.dailyNew > 50"
            >旧计划可保留原来的 {{ original.dailyNew }} 词。</template
          >
        </p>
        <section class="planning-forecast" aria-label="学习安排预览" :aria-busy="previewBusy">
          <p v-if="previewBusy">正在计算安排…</p>
          <template v-else-if="preview"
            ><h3>
              {{ preview.total.toLocaleString() }} 词 · 剩余
              {{ preview.remaining.toLocaleString() }} 新词 · {{ preview.days }} 天
            </h3>
            <p>新词安排；到期复习按每日上限进入。</p>
            <ul>
              <li v-for="day in preview.firstDays" :key="day.day">
                <time>{{ day.day }}</time
                ><span>{{ day.count }} 新词</span>
              </li>
            </ul>
            <p v-if="!preview.remaining"> 目标内的新词已学过，可继续到期复习和自由练习。 </p>
          </template>
        </section>
        <p class="planning-note">
          {{
            original.goal && !adjust
              ? "保存后替换当前规划，已学记录与采集内容保留。"
              : "按自己的节奏学习，随时可以调整。"
          }}
        </p>
      </template>
      <p v-if="conflict" role="alert">
        规划已在其他窗口更新。请关闭后重新打开，你的草稿尚未覆盖原规划。
      </p>
      <p v-if="error" role="alert">{{ error }}</p>
    </div>
    <footer>
      <div class="planning-action-controls" data-guide="planning-actions">
        <button
          class="button"
          :disabled="busy"
          @click="stage === 'schedule' && !adjust ? previous() : emit('close')"
        >
          {{ stage === "schedule" && !adjust ? "上一步" : "取消" }}
        </button>
        <button
          v-if="stage === 'target'"
          class="button primary"
          :disabled="!selected || busy"
          @click="next"
        >
          下一步：设置计划
        </button>
        <button
          v-else
          class="button primary"
          :disabled="busy || conflict || !valid || !preview || previewBusy"
          @click="save"
        >
          <Icon name="check" />{{ adjust ? "保存学习计划" : "保存学习规划" }}
        </button>
      </div>
    </footer>
  </AppDialog>
</template>
