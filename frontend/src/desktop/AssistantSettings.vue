<script setup>
import { onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api.js";
import Icon from "../components/Icon.vue";

const LABELS = {
  cursor: "Cursor",
  codex: "Codex",
  "claude-code": "Claude Code",
};
const STATUS = {
  missing: "未安装",
  available: "可接入",
  connected: "已接入",
  broken: "失效",
};

const state = ref(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  message = ref("");
let disposed = false,
  sequence = 0;

async function refresh() {
  const ticket = ++sequence;
  try {
    const value = await api.assistantSettings({ action: "state" });
    if (!disposed && ticket === sequence) state.value = value;
  } catch (failure) {
    if (!disposed && ticket === sequence) error.value = failure.message;
  } finally {
    if (!disposed) loading.value = false;
  }
}

async function perform(input) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  message.value = "";
  sequence++;
  try {
    const result = await api.assistantSettings(input);
    if (disposed) return;
    if (input.action === "connect") message.value = "已写入本机配置，重启对应客户端后即可使用。";
    if (input.action === "disconnect") message.value = "已删除词遇写入的配置项。";
    if (input.action === "setWriteEnabled")
      message.value = input.enabled ? "已允许加入单词本。" : "已撤销加入单词本授权。";
    if (input.action === "test")
      message.value = result.test?.ok
        ? `测试连接成功，可用工具 ${result.test.tools.join("、")}。`
        : result.test?.error || "测试连接失败。";
    await refresh();
  } catch (failure) {
    if (!disposed) error.value = failure.message;
  } finally {
    if (!disposed) busy.value = false;
  }
}

onMounted(refresh);
onBeforeUnmount(() => {
  disposed = true;
  sequence++;
});
</script>

<template>
  <section class="settings-section assistant-settings" aria-label="AI 助手连接">
    <div class="connection-heading">
      <h2>AI 助手连接</h2>
      <span class="connection-service" :class="{ ready: state?.transport?.running }">
        <i aria-hidden="true" />{{
          loading ? "检查中" : state?.transport?.running ? "本机服务就绪" : "服务不可用"
        }}
      </span>
    </div>
    <p>
      让 Cursor、Codex 或 Claude Code 查询词遇的词典、单词本与复习进度。这与浏览器插件的 LMCP
      连接不同；默认只读，不能替你提交复习判题。
    </p>
    <p class="error-banner" role="alert" v-if="error">{{ error }}</p>
    <p class="connection-feedback" role="status" v-if="message">{{ message }}</p>
    <div class="setting-option">
      <label class="inline-check">
        <input
          type="checkbox"
          :checked="state?.writeEnabled"
          :disabled="busy || !state"
          @change="perform({ action: 'setWriteEnabled', enabled: $event.target.checked })"
        />允许助手把单词加入单词本
      </label>
      <p class="muted">默认关闭。打开后可随时撤销。助手仍然不能提交复习结果。</p>
    </div>
    <div class="connection-devices">
      <article class="connection-device" v-for="client in state?.clients || []" :key="client.id">
        <Icon name="code" />
        <div>
          <strong>{{ LABELS[client.id] }}</strong>
          <small>{{ STATUS[client.status] }}{{ client.file ? ` · ${client.file}` : "" }}</small>
        </div>
        <button
          v-if="client.status !== 'connected'"
          class="button primary"
          :disabled="busy || !state?.transport?.running"
          @click="perform({ action: 'connect', clientId: client.id })"
        >
          一键接入
        </button>
        <button
          v-else
          class="text-button"
          :disabled="busy"
          @click="perform({ action: 'disconnect', clientId: client.id })"
        >
          断开
        </button>
      </article>
    </div>
    <div class="row">
      <button
        class="button"
        :disabled="busy || !state?.transport?.running"
        @click="perform({ action: 'test' })"
      >
        测试连接
      </button>
    </div>
    <p class="muted">
      桌面未运行时，助手会收到
      DESKTOP_NOT_RUNNING，不会自动打开词遇。配置里只有稳定转发脚本的绝对路径，不含核心令牌。
    </p>
  </section>
</template>
