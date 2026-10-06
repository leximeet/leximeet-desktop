<script setup>
import { computed, ref } from "vue";
import {
  CARD_LEVELS,
  CARD_MODULES,
  RECORD_CARD_SECTIONS,
  moveRecordCardSection,
  toggleCardSection,
  visibleCardSections,
} from "../lib/card-layout.js";

const props = defineProps({ layout: Object, busy: Boolean, perform: Function });
const editing = ref(false);
const draftSections = ref([]);
const activeSections = computed(() => visibleCardSections(props.layout));
const recordOrder = computed(() =>
  draftSections.value.filter((id) => RECORD_CARD_SECTIONS.includes(id)),
);
const draftOrder = computed(() => [
  ...draftSections.value,
  ...CARD_MODULES.map((module) => module.id).filter((id) => !draftSections.value.includes(id)),
]);
const moduleById = new Map(CARD_MODULES.map((module) => [module.id, module]));
const levelName = computed(
  () => CARD_LEVELS.find((level) => level.id === props.layout?.level)?.name || "适中",
);

async function selectLevel(level) {
  if (props.busy || editing.value) return;
  await props.perform(
    "cardLayout",
    {
      expectedRevision: props.layout?.revision ?? 0,
      level,
      mode: "preset",
      // 切换预设不销毁已保存的自定义排布，之后可以直接切回自定义。
      customSections: [
        ...(props.layout?.customSections || CARD_MODULES.map((module) => module.id)),
      ],
    },
    "词卡等级已保存",
  );
}

function beginCustom() {
  // 初次自定义从当前所见布局开始；曾保存过自定义时保留原来的编排。
  draftSections.value = props.layout?.customSaved
    ? [...(props.layout.customSections || [])]
    : [...activeSections.value];
  editing.value = true;
}

async function saveCustom() {
  const result = await props.perform(
    "cardLayout",
    {
      expectedRevision: props.layout?.revision ?? 0,
      level: props.layout?.level || "balanced",
      mode: "custom",
      customSections: [...draftSections.value],
    },
    "自定义词卡已保存",
  );
  // 冲突或 Core 不可达时保留草稿，用户可以复制当前选择后再处理。
  if (result) editing.value = false;
}
</script>

<template>
  <section class="settings-section card-layout-settings" aria-labelledby="card-layout-title">
    <h2 id="card-layout-title">词卡等级</h2>
    <p class="card-layout-help">选择阅读时显示的内容。默认使用适中。</p>
    <div class="card-level-grid" role="group" aria-label="词卡展示等级">
      <button
        v-for="level in CARD_LEVELS"
        :key="level.id"
        class="card-level-choice"
        :class="{ active: layout?.mode === 'preset' && layout.level === level.id }"
        :aria-pressed="layout?.mode === 'preset' && layout.level === level.id"
        :disabled="busy || editing"
        @click="selectLevel(level.id)"
      >
        <strong>{{ level.name }}</strong>
        <small>{{ level.description }}</small>
        <span>{{ level.sections.length }} 个模块</span>
      </button>
    </div>
    <div class="card-layout-summary">
      <div>
        <strong>当前展示：{{ layout?.mode === "custom" ? "自定义" : levelName }}</strong>
        <p>{{ activeSections.map((id) => moduleById.get(id)?.name).join(" · ") }}</p>
      </div>
      <button v-if="!editing" class="button" :disabled="busy" @click="beginCustom"
        >自定义词卡面板</button
      >
    </div>
    <div v-if="editing" class="card-layout-editor" role="region" aria-label="自定义词卡面板">
      <p>勾选要展示的内容，词头与释义始终保留。记录页内的模块可调整顺序。</p>
      <ol>
        <li v-for="id in draftOrder" :key="id" :class="{ muted: !draftSections.includes(id) }">
          <label>
            <input
              type="checkbox"
              :checked="draftSections.includes(id)"
              :disabled="id === 'meaning' || busy"
              :aria-label="`显示${moduleById.get(id).name}`"
              @change="draftSections = toggleCardSection(draftSections, id)"
            />
            <span
              ><strong>{{ moduleById.get(id).name }}</strong
              ><small>{{ moduleById.get(id).description }}</small></span
            >
          </label>
          <div v-if="RECORD_CARD_SECTIONS.includes(id)" class="card-layout-order">
            <button
              type="button"
              :aria-label="`上移${moduleById.get(id).name}`"
              :disabled="busy || !draftSections.includes(id) || recordOrder.indexOf(id) === 0"
              @click="draftSections = moveRecordCardSection(draftSections, id, -1)"
              >↑</button
            >
            <button
              type="button"
              :aria-label="`下移${moduleById.get(id).name}`"
              :disabled="
                busy ||
                !draftSections.includes(id) ||
                recordOrder.indexOf(id) === recordOrder.length - 1
              "
              @click="draftSections = moveRecordCardSection(draftSections, id, 1)"
              >↓</button
            >
          </div>
        </li>
      </ol>
      <div class="row card-layout-actions">
        <button class="button primary" :disabled="busy" @click="saveCustom">保存词卡排布</button>
        <button class="button" :disabled="busy" @click="editing = false">取消</button>
      </div>
    </div>
  </section>
</template>
