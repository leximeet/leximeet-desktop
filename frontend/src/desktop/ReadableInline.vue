<script setup>
import { computed } from "vue";
import { readableInline } from "../lib/readable-markdown.js";
import { api } from "../lib/api.js";
const props = defineProps({ text: { type: String, default: "" } });
const nodes = computed(() => readableInline(props.text));
</script>
<template>
  <template v-for="(node, index) in nodes" :key="index">
    <strong v-if="node.kind === 'strong'">{{ node.text }}</strong>
    <em v-else-if="node.kind === 'em'">{{ node.text }}</em>
    <code v-else-if="node.kind === 'code'">{{ node.text }}</code>
    <a
      v-else-if="node.kind === 'link'"
      :href="node.href"
      target="_blank"
      rel="noopener noreferrer"
      @click.prevent="api.openExternal(node.href).catch(() => {})"
      >{{ node.text }}</a
    >
    <template v-else>{{ node.text }}</template>
  </template>
</template>
