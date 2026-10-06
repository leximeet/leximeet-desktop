<script setup>
import { computed } from "vue";
import { readableMarkdown } from "../lib/readable-markdown.js";
import ReadableInline from "./ReadableInline.vue";
const props = defineProps({ text: { type: String, default: "" } });
const blocks = computed(() => readableMarkdown(props.text));
</script>
<template>
  <!-- 词典源内容不进入 v-html；只创建经过白名单限制的文字排版节点。 -->
  <div class="readable-text">
    <component :is="block.tag" v-for="(block, index) in blocks" :key="index">
      <template v-if="block.items"
        ><li v-for="(item, n) in block.items" :key="n"> <ReadableInline :text="item" /></li
      ></template>
      <template v-else-if="block.tag === 'pre'">{{ block.text }}</template>
      <ReadableInline v-else :text="block.text || ''" />
    </component>
  </div>
</template>
<style scoped>
.readable-text {
  line-height: 1.8;
  overflow-wrap: anywhere;
}
.readable-text :is(h4, h5, h6) {
  font-size: 1em;
  font-weight: 650;
  margin: 20px 0 8px;
}
.readable-text :is(p, blockquote, pre) {
  margin: 8px 0;
  white-space: pre-wrap;
}
.readable-text :is(ol, ul) {
  padding-left: 24px;
  margin: 8px 0;
}
.readable-text li {
  margin: 4px 0;
}
.readable-text pre {
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  overflow-x: auto;
}
.readable-text blockquote {
  padding-left: 12px;
  border-left: 2px solid var(--line-strong);
}
.readable-text :deep(a) {
  color: var(--accent);
}
</style>
