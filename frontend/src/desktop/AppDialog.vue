<script setup>
import { ref, onMounted, onBeforeUnmount } from "vue";
import Icon from "../components/Icon.vue";
defineProps({
  title: String,
  busy: Boolean,
  variant: String,
  teaching: Boolean,
});
const emit = defineEmits(["close"]);
const dialog = ref(null);
// 原生 dialog 管理焦点圈定和关闭后的焦点恢复，避免在页面上手写另一套遮罩键盘逻辑。
onMounted(() => dialog.value.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <Teleport to="body"
    ><dialog
      ref="dialog"
      class="app-dialog"
      :class="[variant, { 'with-teaching': teaching }]"
      :aria-label="title"
      @cancel.prevent="!busy && emit('close')"
    >
      <header>
        <h2>{{ title }}</h2>
        <button class="icon-button" aria-label="关闭对话框" :disabled="busy" @click="emit('close')">
          <Icon name="x" />
        </button>
      </header>
      <slot />
      <div v-if="teaching" class="dialog-guide-host" data-guide-host /></dialog
  ></Teleport>
</template>
