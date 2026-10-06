<script setup>
import { computed, ref, nextTick, watch } from "vue";
import { createSpellingSelection } from "./spelling-selection.js";
const props = defineProps({
  value: String,
  answer: String,
  copy: Boolean,
  hint: Boolean,
  disabled: Boolean,
  correct: Boolean,
});
const emit = defineEmits(["update", "submit", "type"]);
const field = ref(null),
  focused = ref(false),
  position = ref(0),
  composing = ref(false),
  preedit = ref("");
const selection = createSpellingSelection();
function rememberSelection(field) {
  const start = selection.remember(field);
  if (start !== undefined) position.value = start;
}
function restoreSelection() {
  if (composing.value) return;
  const start = selection.restore(field.value);
  if (start !== undefined) position.value = start;
}
function gainedFocus() {
  focused.value = true;
  restoreSelection();
}
function lostFocus(event) {
  // disabled 引起的 blur 可能已重置原生选区；禁用之前保存的位置才是用户真实位置。
  if (!props.disabled) rememberSelection(event.target);
  focused.value = false;
}
watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) rememberSelection(field.value);
  },
  { flush: "sync" },
);
watch(
  () => props.value,
  () => {
    if (focused.value) restoreSelection();
  },
  { flush: "post" },
);
const displayValue = computed(() => (composing.value ? preedit.value : props.value || ""));
// 答案只存在于视觉提示层；真实输入仍是用户草稿，揭示后也能继续键入、退格与确认。
const prompted = computed(() => props.copy || props.hint);
const letters = computed(() => [...(prompted.value ? props.answer : displayValue.value)]);
function change(event) {
  if (composing.value || event.isComposing) {
    preedit.value = event.target.value;
    rememberSelection(event.target);
    return;
  }
  const value = event.target.value;
  rememberSelection(event.target);
  emit("update", value);
  emit("type");
}
// 输入法的 Enter 属于确认候选，不能 preventDefault，否则预编辑内容无法上屏。
function keydown(event) {
  if (event.key !== "Enter" || composing.value || event.isComposing || event.keyCode === 229)
    return;
  event.preventDefault();
  emit("submit");
}
async function focus() {
  await nextTick();
  field.value?.focus({ preventScroll: true });
  restoreSelection();
}
defineExpose({ focus });
</script>
<template>
  <div class="spelling-editor" :class="{ focused, complete: correct }" @click="focus">
    <div class="spelling-letters practice-headword" aria-hidden="true">
      <span
        v-for="(letter, index) in letters"
        :key="index"
        :class="{
          ghost: prompted && !displayValue[index],
          typed: prompted && displayValue[index]?.toLowerCase() === letter.toLowerCase(),
          wrong:
            prompted &&
            displayValue[index] &&
            displayValue[index]?.toLowerCase() !== letter.toLowerCase(),
          caret: focused && index === position,
        }"
        >{{ letter === " " ? "\u00a0" : letter }}</span
      >
      <span
        v-if="!prompted || position >= letters.length"
        :class="{ caret: focused && position >= letters.length }"
        class="spelling-tail"
        >{{ !value && !prompted ? "开始输入" : "\u00a0" }}</span
      >
    </div>
    <span v-if="composing" class="spelling-composition" role="status"
      >{{ preedit }} · 确认输入法候选后继续</span
    >
    <!-- 真实聚焦输入保留选择、退格、方向键与输入法；只监听本控件，绝不截获宿主键盘。 -->
    <input
      ref="field"
      :value="displayValue"
      :disabled="disabled"
      :readonly="correct"
      @input="change"
      @focus="gainedFocus"
      @blur="lostFocus"
      @select="rememberSelection($event.target)"
      @keyup="rememberSelection($event.target)"
      @compositionstart="
        composing = true;
        preedit = $event.target.value;
      "
      @compositionend="
        composing = false;
        change($event);
      "
      @keydown="keydown"
      aria-label="练习答案"
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
    />
  </div>
</template>
