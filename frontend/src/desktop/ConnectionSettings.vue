<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { api } from "../lib/api.js";
import Icon from "../components/Icon.vue";

const state = ref(null),
  loading = ref(true),
  busy = ref(false),
  error = ref(""),
  message = ref(""),
  confirmation = ref(null);
let disposed = false,
  sequence = 0,
  timer;
const clients = computed(() =>
  (state.value?.clients || []).filter(
    (client) => !client.revoked && client.connectionState !== "disconnected",
  ),
);
const discovered = computed(() =>
  (state.value?.discoveredClients || []).filter(
    (client) =>
      !(state.value?.clients || []).some(
        (pair) =>
          pair.clientInstanceId === client.clientInstanceId &&
          pair.origin === client.origin &&
          !pair.revoked &&
          pair.connectionState === "connected",
      ),
  ),
);
function live(client) {
  return (state.value?.transport?.connections || []).some(
    (connection) =>
      connection.clientInstanceId === client.clientInstanceId &&
      connection.pairingId === client.pairingId &&
      connection.businessReady,
  );
}
async function refresh() {
  const ticket = ++sequence;
  try {
    const value = await api.connectionSettings({ action: "state" });
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
    await api.connectionSettings(input);
    if (disposed) return;
    if (input.action === "requestConnection")
      message.value = "邀请已发送，请在浏览器弹窗确认连接。";
    if (input.action === "disconnect")
      message.value = "已断开连接，插件将恢复原独立资料。桌面资料保留。";
    if (input.action === "cancelInvitation") message.value = "已取消连接邀请。";
    confirmation.value = null;
    await refresh();
  } catch (failure) {
    if (!disposed) error.value = failure.message;
  } finally {
    if (!disposed) busy.value = false;
  }
}
onMounted(async () => {
  await refresh();
  if (!disposed)
    timer = setInterval(() => {
      if (!busy.value && !document.hidden) refresh();
    }, 1500);
});
onBeforeUnmount(() => {
  disposed = true;
  sequence++;
  clearInterval(timer);
});
</script>
<template>
  <section class="settings-section connection-settings" aria-label="插件连接设置">
    <div class="connection-heading">
      <h2>插件连接</h2>
      <span class="connection-service" :class="{ ready: state?.transport?.running }"
        ><i aria-hidden="true" />{{
          loading ? "检查中" : state?.transport?.running ? "本机服务就绪" : "服务不可用"
        }}</span
      >
    </div>
    <p>网页查词与采集使用桌面资料，学习与管理在桌面端完成。</p>
    <p class="error-banner" role="alert" v-if="error">{{ error }}</p>
    <p class="connection-feedback" role="status" v-if="message">
      {{ message }}
    </p>
    <div class="connection-devices">
      <div class="connection-heading">
        <h3>可连接的插件</h3>
        <button
          class="text-button"
          aria-label="检查可连接的插件"
          :disabled="busy"
          @click="perform({ action: 'scan' })"
        >
          <Icon name="refresh" />重新检测
        </button>
      </div>
      <div class="connection-empty" v-if="!discovered.length">
        <Icon name="plug-connected" />
        <div>
          <strong>等待插件出现</strong><small>安装词遇插件并打开浏览器，检测到后会主动提醒。</small>
        </div>
      </div>
      <article
        class="connection-device"
        v-for="client in discovered"
        :key="`${client.origin}:${client.clientInstanceId}`"
      >
        <Icon name="plug-connected" />
        <div>
          <strong>{{ client.displayName }}</strong
          ><small>{{
            client.invitation?.state === "pending"
              ? "等待浏览器确认"
              : "可以连接 · 原独立资料会保留"
          }}</small>
        </div>
        <template v-if="client.invitation?.state === 'pending'">
          <button
            class="text-button"
            :disabled="busy"
            @click="
              perform({
                action: 'cancelInvitation',
                invitationId: client.invitation.invitationId,
              })
            "
          >
            取消邀请
          </button>
          <span class="connection-waiting" role="status">等待确认</span>
        </template>
        <button
          v-else
          class="button primary"
          :disabled="busy || !state?.transport?.running"
          @click="
            perform({
              action: 'requestConnection',
              clientInstanceId: client.clientInstanceId,
              origin: client.origin,
            })
          "
        >
          一键连接
        </button>
      </article>
    </div>
    <div class="connection-devices">
      <div class="connection-heading"><h3>当前连接</h3></div>
      <div class="connection-empty" v-if="!clients.length">
        <span>还没有插件连接这台电脑</span>
      </div>
      <article class="connection-device" v-for="client in clients" :key="client.pairingId">
        <Icon name="plug-connected" />
        <div>
          <strong>{{ client.displayName }}</strong
          ><small :class="{ 'connection-online': live(client) }">{{
            live(client) ? "连接成功" : "暂时离线 · 等待恢复"
          }}</small>
        </div>
        <button
          class="button"
          :disabled="busy"
          @click="
            perform({
              action: 'disconnect',
              clientInstanceId: client.clientInstanceId,
            })
          "
        >
          断开连接
        </button>
        <button class="text-button" :disabled="busy" @click="confirmation = client">
          撤销授权
        </button>
        <div class="connection-confirm" v-if="confirmation?.pairingId === client.pairingId">
          <span>撤销后需重新确认连接。已采集到桌面的资料保留。</span>
          <div class="row">
            <button class="button small" :disabled="busy" @click="confirmation = null"> 取消</button
            ><button
              class="button small danger"
              :disabled="busy"
              @click="
                perform({
                  action: 'revoke',
                  clientInstanceId: client.clientInstanceId,
                })
              "
            >
              确认撤销
            </button>
          </div>
        </div>
      </article>
    </div>
    <details class="connection-explanation">
      <summary>连接与独立使用有什么区别？</summary>
      <p>
        连接时，插件原资料在本机封存，网页采集写入桌面。在任一端断开后，插件恢复原资料，桌面保留采集。临时失联会等待重连。
      </p>
    </details>
    <details
      class="connection-explanation"
      v-if="
        state?.discovery?.lastError ||
        state?.transport?.lastError ||
        state?.notifications?.lastError
      "
    >
      <summary>连接诊断</summary>
      <p v-if="state?.discovery?.lastError">{{ state.discovery.lastError }}</p>
      <p v-if="state?.transport?.lastError">{{ state.transport.lastError }}</p>
      <p v-if="state?.notifications?.lastError">
        {{ state.notifications.lastError }}
      </p>
    </details>
  </section>
</template>
<style scoped>
.connection-heading,
.connection-device {
  display: flex;
  align-items: center;
  gap: 16px;
  justify-content: space-between;
}
.connection-heading h2,
.connection-heading h3 {
  margin: 0;
}
.connection-heading h3 {
  font-size: 14px;
  font-weight: 600;
}
.connection-service {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
}
.connection-service i {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--muted);
}
.connection-service.ready,
.connection-online {
  color: var(--accent);
}
.connection-service.ready i {
  background: var(--accent);
}
.connection-devices {
  padding: 24px 0;
  border-top: 1px solid var(--line);
}
.connection-devices .text-button {
  display: flex;
  align-items: center;
  gap: 4px;
}
.connection-devices .icon {
  width: 18px;
  height: 18px;
  flex: none;
}
.connection-empty {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 28px 0 6px;
  color: var(--muted);
  font-size: 13px;
}
.connection-empty > div {
  display: grid;
  gap: 8px;
}
.connection-empty strong {
  font-size: 13px;
  font-weight: 500;
}
.connection-empty small {
  font-size: 12px;
  line-height: 1.7;
}
.connection-device {
  justify-content: start;
  flex-wrap: wrap;
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}
.connection-device > div:not(.connection-confirm) {
  flex: 1;
  min-width: 120px;
  display: grid;
  gap: 6px;
}
.connection-device strong {
  font-size: 14px;
  overflow-wrap: anywhere;
}
.connection-device small {
  font-size: 12px;
  color: var(--muted);
}
.connection-device small.connection-online {
  color: var(--accent);
}
.connection-feedback,
.connection-waiting {
  color: var(--accent);
  font-size: 12px;
}
.connection-confirm {
  width: 100%;
  padding: 16px;
  background: var(--hover);
  border-radius: 8px;
  font-size: 12px;
  display: grid;
  gap: 12px;
}
.connection-explanation {
  margin-top: 18px;
}
.connection-explanation summary {
  font-size: 12px;
  cursor: pointer;
  color: var(--muted);
}
.connection-explanation p {
  max-width: 650px;
  line-height: 1.8;
}
@media (max-width: 700px) {
  .connection-heading {
    gap: 8px;
  }
  .connection-service {
    font-size: 11px;
  }
  .connection-device {
    gap: 10px;
  }
}
</style>
