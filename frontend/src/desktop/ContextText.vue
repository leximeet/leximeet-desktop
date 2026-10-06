<script setup>
import { computed } from "vue";
const props = defineProps({ text: String, word: String });
// 只拆分文本节点，不通过 innerHTML 渲染个人语境或词典文本。
const parts = computed(() => {
  if (!props.word) return [props.text || ""];
  const escaped = props.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (props.text || "").split(new RegExp(`(?<![A-Za-z])(${escaped})(?![A-Za-z])`, "gi"));
});
</script>
<template>
  <template v-for="(part, index) in parts" :key="index"
    ><mark v-if="index % 2">{{ part }}</mark
    ><template v-else>{{ part }}</template></template
  >
</template>
