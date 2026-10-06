<script setup>
import { reactive, ref, onMounted, onBeforeUnmount } from "vue";
import Icon from "../components/Icon.vue";
const state = ref(null),
  error = ref(""),
  notice = ref(""),
  busy = ref(false),
  draftMode = ref("capture"),
  time = ref(Date.now());
const draft = reactive({
  word: "",
  context: "",
  sourceTitle: "",
  sourceUrl: "",
});
const bridge = window.leximeetCapture;
let off,
  timer,
  loaded = false;
async function refresh() {
  try {
    state.value = await bridge.action({ action: "state" });
    const theme = state.value.theme;
    document.documentElement.dataset.theme =
      theme === "dark" || (theme === "system" && matchMedia("(prefers-color-scheme:dark)").matches)
        ? "dark"
        : "light";
    if (!loaded || !Object.values(draft).some(Boolean)) {
      draft.word = state.value.word;
      draftMode.value = state.value.mode;
      loaded = true;
    }
  } catch (failure) {
    error.value = failure.message;
  }
}
async function save() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await bridge.action({
      action: "save",
      mode: draftMode.value,
      ...draft,
    });
    if (result.captureStatus === "duplicate-context") {
      notice.value = "此语境近期已记录，没有重复采集。";
      return;
    }
    Object.keys(draft).forEach((key) => (draft[key] = ""));
    await bridge.action({ action: "close" });
  } catch (failure) {
    error.value = failure.message;
  } finally {
    busy.value = false;
  }
}
async function decide(id, collect) {
  try {
    await bridge.action({ action: "decision", id, collect });
    await refresh();
  } catch (failure) {
    error.value = failure.message;
  }
}
onMounted(async () => {
  off = bridge.onChanged(refresh);
  await refresh();
  if (state.value?.kind === "inbox") await bridge.action({ action: "ready" });
  timer = setInterval(() => (time.value = Date.now()), 200);
});
onBeforeUnmount(() => {
  off?.();
  clearInterval(timer);
});
</script>
<template>
  <div class="desktop-shell capture-window-shell">
    <header class="capture-window-title">
      <span>{{ state?.kind === "inbox" ? "剪贴板采集" : "遇见采集" }}</span>
    </header>
    <main class="capture-window-body">
      <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>
      <template v-if="state?.kind === 'inbox'">
        <h1>刚刚遇见的单词</h1>
        <p class="muted" v-if="state.error">{{ state.error }}</p>
        <article v-for="item in state.items" :key="item.id" class="capture-notification">
          <div class="section-heading">
            <h2>{{ item.word }}</h2>
            <small>{{
              item.status === "failed"
                ? "结果待确认"
                : item.status === "saving"
                  ? "保存中"
                  : item.expiresAt
                    ? Math.max(0, Math.ceil((item.expiresAt - time) / 1000)) + " 秒"
                    : "准备中"
            }}</small>
          </div>
          <p class="capture-context">{{ item.context }}</p>
          <div class="row" v-if="item.status === 'pending'">
            <button class="button small primary" @click="decide(item.id, true)"> 采集 </button>
            <button class="button small" @click="decide(item.id, false)"> 不采集 </button>
            <small class="muted">{{ item.autoCollect ? "到时自动采集" : "到时不采集" }}</small>
          </div>
          <div class="row" v-else-if="item.status === 'failed'">
            <button class="button small primary" @click="decide(item.id, true)"> 重试采集 </button>
            <button class="button small" @click="decide(item.id, false)"> 关闭提示 </button>
          </div>
          <p v-else class="muted">
            {{ item.status === "saving" ? "正在保存…" : "本次未采集" }}
          </p>
        </article>
      </template>
      <form v-else-if="state" @submit.prevent="save" class="capture-editor">
        <h1>
          {{ draftMode === "collect" ? "收藏一个单词" : "记录一次遇见" }}
        </h1>
        <label
          >单词或短语<input
            v-model="draft.word"
            aria-label="捕获单词"
            required
            maxlength="120"
            autofocus
        /></label>
        <template v-if="draftMode === 'capture'">
          <label
            >遇见它的句子<textarea
              v-model="draft.context"
              aria-label="捕获语境"
              required
              maxlength="20000"
              placeholder="保留这次遇见的语境…"
            />
          </label>
          <details>
            <summary class="muted">添加来源</summary>
            <label>来源标题<input v-model="draft.sourceTitle" maxlength="300" /></label
            ><label>来源网址<input v-model="draft.sourceUrl" type="url" maxlength="2000" /></label>
          </details>
        </template>
        <footer class="row">
          <button class="button primary" :disabled="busy">
            <Icon name="check" />{{ draftMode === "collect" ? "保存收藏" : "确认保存遇见" }}</button
          ><button type="button" class="text-button" @click="bridge.action({ action: 'close' })">
            稍后再写
          </button>
        </footer>
      </form>
    </main>
  </div>
</template>
