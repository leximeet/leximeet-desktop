<script setup>
import { computed, ref, watch, nextTick } from "vue";
import { PRACTICE_MODES } from "./practice-session.js";
const props = defineProps({
  profile: Object,
  delivery: Object,
  command: Function,
  busy: Boolean,
});
const selection = ref([...props.profile.reminderModes]);
const baseline = ref(JSON.stringify(selection.value)),
  revision = ref(props.profile.revision),
  failed = ref(false),
  saved = ref(false);
const dirty = computed(() => JSON.stringify(selection.value) !== baseline.value);
function reset() {
  selection.value = [...props.profile.reminderModes];
  baseline.value = JSON.stringify(selection.value);
  revision.value = props.profile.revision;
  failed.value = false;
}
// 无草稿时跟随 Core；未保存的选择不会被定时刷新或其他设置回执覆盖。
watch(
  () => [JSON.stringify(props.profile.reminderModes), props.profile.revision],
  () => {
    if (!dirty.value) reset();
  },
  { immediate: true },
);
async function save() {
  saved.value = false;
  const modes = [...selection.value];
  const success = await props.command({
    action: "saveReminderPreferences",
    reminderModes: modes,
    expectedRevision: revision.value,
  });
  failed.value = !success;
  if (success) {
    await nextTick();
    baseline.value = JSON.stringify(modes);
    revision.value = props.profile.revision;
    saved.value = true;
  }
}
</script>
<template>
  <section class="settings-section reminder-settings">
    <h2>学习提醒</h2>
    <div class="reminder-cadence">
      <strong>约 30 分钟随机提醒</strong>
      <span class="muted">在学习规划的提醒时段内</span>
    </div>
    <form @submit.prevent="save">
      <fieldset class="reminder-mode-options" :disabled="busy">
        <legend>通知中的练习 <small>多选时轮换，每次一道题</small></legend>
        <label v-for="item in PRACTICE_MODES" :key="item[0]">
          <input type="checkbox" v-model="selection" :value="item[0]" @change="saved = false" />{{
            item[1]
          }}
        </label>
      </fieldset>
      <p v-if="!selection.length" role="alert">请至少选择一种练习。</p>
      <p class="muted">应用在前台时不提醒，关闭或忽略通知不扣分。</p>
      <div class="row">
        <button class="button primary" :disabled="busy || !selection.length || !dirty">
          {{ busy ? "保存中…" : "保存提醒设置" }}
        </button>
        <button v-if="failed" type="button" class="text-button" @click="reset"> 重新载入 </button>
        <span v-if="saved && !dirty" class="muted" role="status">提醒设置已保存</span>
      </div>
    </form>
    <p v-if="['failed', 'unavailable'].includes(delivery?.state)" role="status">
      {{ delivery.message }}
    </p>
  </section>
</template>
