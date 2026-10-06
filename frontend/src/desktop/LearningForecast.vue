<script setup>
import { computed, ref, watch } from "vue";
import { forecastCurve, forecastDayLabel } from "./learning-forecast.js";
import "./styles/forecast.css";
const props = defineProps({ forecast: Object, dailyReview: Number, goal: String });
const horizon = ref("30"),
  selectedDay = ref(0);
const points = computed(() => forecastCurve(props.forecast, horizon.value));
const maximum = computed(() =>
  Math.max(10, Math.ceil((points.value.at(-1)?.count || 0) / 10) * 10),
);
const path = computed(() =>
  points.value
    .map(
      (point, i, all) =>
        `${i ? "L" : "M"}${64 + (610 * point.offset) / Math.max(1, all.at(-1).offset)},${196 - (160 * point.count) / maximum.value}`,
    )
    .join(" "),
);
const days = computed(() => props.forecast.firstDays || []);
const day = computed(() => days.value[selectedDay.value]);
// 目标切换不带走旧日期选择；刷新保留还在当前预览内的日期。
watch(
  () => props.goal,
  () => (selectedDay.value = 0),
);
watch(
  () => days.value.length,
  (length) => (selectedDay.value = Math.min(selectedDay.value, Math.max(0, length - 1))),
);
</script>
<template>
  <section class="learning-forecast" aria-label="学习预测面板">
    <div class="forecast-metrics">
      <div
        ><span>已完成初学</span
        ><strong
          >{{ forecast.learned.toLocaleString()
          }}<small> / {{ forecast.total.toLocaleString() }} 词</small></strong
        ></div
      >
      <div
        ><span>待完成初学</span
        ><strong>{{ forecast.remaining.toLocaleString() }}<small> 词</small></strong></div
      >
      <div
        ><span>按每日额度推算</span
        ><strong>{{ forecast.days ? forecast.days + " 天" : "已完成" }}</strong
        ><small v-if="forecast.days">预计到 {{ forecast.endOn }}</small></div
      >
    </div>
    <div class="forecast-visuals">
      <div class="forecast-curve-panel">
        <header class="forecast-heading">
          <h2>初学完成曲线</h2>
          <select v-model="horizon" aria-label="预测区间">
            <option value="7">未来 7 天</option
            ><option value="30">未来 30 天</option
            ><option value="90">未来 90 天</option
            ><option value="all">整个计划</option>
          </select>
        </header>
        <svg
          viewBox="0 0 700 238"
          role="img"
          aria-label="按每日额度推算的初学完成数量曲线"
          class="forecast-chart"
        >
          <title>预计初学完成数量</title>
          <desc>
            当前完成 {{ forecast.learned }} 词。如果每天完成新学额度，所选区间末预计完成
            {{ points.at(-1)?.count || 0 }} 词。此图不代表已熟悉词量。
          </desc>
          <g v-for="fraction in [0, 0.5, 1]" :key="fraction">
            <line x1="64" x2="674" :y1="196 - fraction * 160" :y2="196 - fraction * 160" />
            <text x="52" :y="200 - fraction * 160" text-anchor="end">
              {{ Math.round(maximum * fraction).toLocaleString() }}
            </text>
          </g>
          <path :d="path" class="forecast-line" />
          <circle
            v-if="points.length"
            cx="64"
            :cy="196 - (forecast.learned / maximum) * 160"
            r="4"
            class="forecast-current"
          />
          <text x="64" y="223">当前</text>
          <text x="674" y="223" text-anchor="end">
            {{ forecastDayLabel(forecast, points.at(-1)?.offset || 0) }}
          </text>
        </svg>
        <p class="forecast-assumption"
          >假设每天完成新学额度。初学完成指首次达到 20 分；复习安排以实际到期为准，每天上限
          {{ dailyReview }} 词。</p
        >
      </div>
      <div class="forecast-upcoming">
        <header class="forecast-heading"><h2>近期要学的词</h2><span>按当前目标顺序</span></header>
        <div v-if="days.length" class="forecast-days" role="tablist" aria-label="新词预览日期">
          <button
            v-for="(item, index) in days"
            :key="item.day"
            role="tab"
            :aria-selected="selectedDay === index"
            :class="{ active: selectedDay === index }"
            @click="selectedDay = index"
          >
            <time>{{ item.day.slice(5) }}</time
            ><small>{{ item.count }} 词</small>
          </button>
        </div>
        <div
          v-if="day"
          role="tabpanel"
          :aria-label="day.day + ' 新词预览'"
          class="forecast-word-list"
        >
          <span
            v-for="word in day.words"
            :key="word.id"
            class="forecast-word"
            :title="word.meaning"
            >{{ word.word }}</span
          >
          <p v-if="!day.count">{{
            selectedDay === 0 ? "当前目标今天没有新词安排。" : "这天没有新词安排。"
          }}</p>
          <p v-if="day.count > (day.words?.length || 0)" class="muted"
            >展示前 {{ day.words?.length || 0 }} 词，共 {{ day.count }} 词。</p
          >
        </div>
        <p v-else class="muted">目标新词已学完，继续复习来巩固记忆。</p>
        <p class="forecast-assumption"
          >新学候选会随练习、回收站和学习目标变化，实际内容以今日任务为准。</p
        >
      </div>
    </div>
  </section>
</template>
