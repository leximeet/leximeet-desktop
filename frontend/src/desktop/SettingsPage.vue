<script setup>
import { computed, reactive, ref, watch } from "vue";
import { api } from "../lib/api.js";
import CardLayoutSettings from "../components/CardLayoutSettings.vue";
import ConnectionSettings from "./ConnectionSettings.vue";
import ReminderSettings from "./ReminderSettings.vue";
import Icon from "../components/Icon.vue";
import { GUIDE_STEPS, currentGuideStep } from "./guide-steps.js";
import { defaultCardLayout } from "../lib/card-layout.js";
const props = defineProps({
  state: Object,
  runtime: Object,
  audioSettings: Object,
  busy: Boolean,
  saveSettings: Function,
  native: Function,
  command: Function,
  refresh: Function,
});
// 开关先保留最新用户意图，异步旧回执不能让勾选跳回；最终失败时恢复 Core 已确认值。
const captureDraft = reactive({});
const captureWrites = new Map();
const captureRetryBusy = ref(false),
  captureRetryError = ref("");
// 恢复只由明确点击触发；后台轮询不反复重放失败采集。
async function retryClipboard() {
  if (captureRetryBusy.value) return;
  captureRetryBusy.value = true;
  captureRetryError.value = "";
  try {
    await api.captureAction({ action: "retryClipboard" });
    await props.refresh();
  } catch (failure) {
    captureRetryError.value = failure.message;
  } finally {
    captureRetryBusy.value = false;
  }
}
function captureValue(key, fallback = false) {
  return Object.hasOwn(captureDraft, key)
    ? captureDraft[key]
    : (props.state.settings[key] ?? fallback);
}
async function saveCaptureSetting(key, value) {
  const ticket = Symbol(key);
  captureDraft[key] = value;
  captureWrites.set(key, ticket);
  try {
    await props.saveSettings({ [key]: value });
  } finally {
    if (captureWrites.get(key) === ticket) {
      delete captureDraft[key];
      captureWrites.delete(key);
    }
  }
}
const emit = defineEmits(["audioSaved", "resume-guide", "restart-guide"]);
const panel = ref("appearance");
// 词卡使用默认适中布局；仅展示默认值不会额外写入用户资料。
const cardLayout = computed(() => props.state.settings.cardLayout || defaultCardLayout());
const sections = [
  ["appearance", "外观与词卡", "sun"],
  ["reminder", "学习提醒", "clock"],
  ["audio", "发音", "volume"],
  ["capture", "采集与快捷键", "keyboard"],
  ["connection", "插件连接", "plug-connected"],
  ["data", "本机数据", "folder"],
  ["teaching", "使用教学", "info-circle"],
  ["about", "关于词遇", "book-2"],
];
const completed = computed(() => props.state.guide.completed.length);
// 设置教学只打开分栏讲解，不提交设置。普通浏览时不干涉用户选择。
watch(
  () => [props.state.guide.active, completed.value, props.state.guide.cursor],
  () => {
    if (!props.state.guide.active) return;
    const step = currentGuideStep(props.state.guide)?.id;
    if (step === "theme") panel.value = "appearance";
    if (step === "audioSettings") panel.value = "audio";
    if (["clipboard", "captureSettings"].includes(step)) panel.value = "capture";
  },
  { immediate: true },
);
const clearSecret = ref(false),
  audio = ref(null),
  headers = ref(""),
  audioBusy = ref(false),
  error = ref("");
let audioBaseline = "";
watch(
  () => props.audioSettings,
  (value) => {
    if (value && (!audio.value || JSON.stringify(audio.value) === audioBaseline)) {
      audio.value = JSON.parse(JSON.stringify(value));
      audioBaseline = JSON.stringify(audio.value);
    }
  },
  { immediate: true },
);
async function saveAudio() {
  audioBusy.value = true;
  error.value = "";
  try {
    const value = audio.value;
    const next = await api.audioSettings({
      action: "save",
      provider: value.provider,
      accent: value.accent,
      voice: value.voice,
      rate: Number(value.rate),
      volume: Number(value.volume),
      fallback: value.fallback,
      custom: {
        url: value.custom.url,
        method: value.custom.method,
        body: value.custom.body,
      },
      ...(headers.value ? { headers: headers.value } : {}),
      clearSecret: clearSecret.value,
    });
    headers.value = "";
    clearSecret.value = false;
    audio.value = JSON.parse(JSON.stringify(next));
    audioBaseline = JSON.stringify(next);
    emit("audioSaved", next);
  } catch (failure) {
    error.value = failure.message;
  } finally {
    audioBusy.value = false;
  }
}
async function perform(method, payload) {
  try {
    await api[method](payload);
    await props.refresh();
    return true;
  } catch (failure) {
    error.value = failure.message;
    return false;
  }
}
async function appearance(patch) {
  await props.saveSettings(patch);
}
</script>
<template>
  <section class="d-page settings-page">
    <header class="page-heading">
      <div>
        <h1>设置</h1>
        <p>让阅读与学习适合自己的节奏。</p>
      </div>
    </header>
    <div class="d-settings-layout">
      <nav class="d-settings-navigation" aria-label="设置分类">
        <button
          v-for="item in sections"
          :key="item[0]"
          :class="{ active: panel === item[0] }"
          :aria-pressed="panel === item[0]"
          @click="panel = item[0]"
        >
          <Icon :name="item[2]" />{{ item[1] }}
        </button>
      </nav>
      <div class="d-settings-content">
        <section
          class="settings-section"
          data-guide="appearance-preview"
          v-show="panel === 'appearance'"
        >
          <h2>外观与窗口</h2>
          <div class="form-grid">
            <label
              >主题<select
                data-guide="theme-select"
                :value="state.settings.theme"
                @change="appearance({ theme: $event.target.value })"
              >
                <option value="system">跟随系统</option>
                <option value="light">明亮</option>
                <option value="dark">黑暗</option>
              </select></label
            ><label
              >关闭窗口时<select
                :value="state.settings.closeBehavior"
                @change="saveSettings({ closeBehavior: $event.target.value })"
              >
                <option value="platform">使用平台习惯</option>
                <option value="hide">保留在 Dock / 托盘</option>
                <option value="quit">退出应用</option>
              </select></label
            >
          </div>
        </section>
        <CardLayoutSettings
          v-show="panel === 'appearance'"
          :layout="cardLayout"
          :busy="busy"
          :perform="perform"
        />
        <ReminderSettings
          v-show="panel === 'reminder'"
          :profile="state.profile"
          :delivery="state.reminderDelivery"
          :command="command"
          :busy="busy"
        />
        <section class="settings-section" v-show="panel === 'capture'">
          <h2>系统剪贴板与快捷键</h2>
          <p class="muted">剪贴板补充目标词语境，手动记录可添加任意单词。</p>
          <div class="setting-option">
            <label class="inline-check"
              ><input
                type="checkbox"
                :checked="captureValue('pluginCaptureNotificationsEnabled', true)"
                @change="
                  saveCaptureSetting('pluginCaptureNotificationsEnabled', $event.target.checked)
                "
              />插件采集成功通知</label
            >
            <p class="muted">连接的插件保存遇见后发送系统通知。</p>
            <p
              v-if="runtime?.pluginCaptureNotifications?.lastError"
              class="error-banner"
              role="alert"
            >
              {{ runtime.pluginCaptureNotifications.lastError }}
            </p>
          </div>
          <div class="setting-option" data-guide="clipboard-preview">
            <label class="inline-check"
              ><input
                type="checkbox"
                :checked="captureValue('clipboardCaptureEnabled')"
                @change="saveCaptureSetting('clipboardCaptureEnabled', $event.target.checked)"
              />
              开启剪贴板识别</label
            >
            <p class="muted">
              只提醒当前学习目标中的单词，保存命中单词所在的句子。 未设置学习目标时不提醒。
            </p>
            <label class="capture-notice-mode"
              >采集提醒方式<select
                :value="captureValue('clipboardReminderMode', 'system')"
                @change="saveCaptureSetting('clipboardReminderMode', $event.target.value)"
                aria-label="采集提醒方式"
              >
                <option value="system">系统通知</option>
                <option value="popup">独立弹窗</option>
              </select></label
            >
            <label
              class="inline-check clipboard-policy"
              v-if="state.settings.clipboardCaptureEnabled"
              ><input
                type="checkbox"
                :checked="captureValue('clipboardAutoCollect', true)"
                @change="saveCaptureSetting('clipboardAutoCollect', $event.target.checked)"
              />10 秒后默认采集</label
            >
            <p class="muted" v-if="state.settings.clipboardCaptureEnabled">
              关闭后，到时不采集。可在每条提醒中单独决定。
            </p>
          </div>
          <div class="setting-option">
            <label class="inline-check"
              ><input
                type="checkbox"
                :checked="captureValue('captureSensitiveRedactionEnabled', true)"
                @change="
                  saveCaptureSetting('captureSensitiveRedactionEnabled', $event.target.checked)
                "
              />脱敏采集</label
            >
            <p class="muted"> 邮箱、手机号、证件号及密码、令牌等敏感内容替换为 xxx。 </p>
            <div class="form-grid capture-policy-fields">
              <label
                >重复语境不采集<select
                  aria-label="重复语境不采集"
                  :value="captureValue('captureDuplicateWindowDays', 7)"
                  @change="
                    saveCaptureSetting('captureDuplicateWindowDays', Number($event.target.value))
                  "
                >
                  <option :value="0">关闭</option>
                  <option :value="1">1 天内</option>
                  <option :value="3">3 天内</option>
                  <option :value="7">7 天内</option>
                  <option :value="30">30 天内</option>
                  <option :value="90">90 天内</option>
                </select></label
              >
              <label
                >语境最大长度<input
                  type="number"
                  min="120"
                  max="2000"
                  step="1"
                  aria-label="语境最大长度"
                  :value="captureValue('captureContextMaxLength', 500)"
                  @change="
                    saveCaptureSetting('captureContextMaxLength', Number($event.target.value))
                  "
              /></label>
            </div>
            <p class="muted">剪贴板、手动记录和连接的插件共用这套采集规则。</p>
          </div>
          <div
            v-if="runtime?.captureNotice?.error || captureRetryError"
            class="error-banner"
            role="alert"
          >
            <span>{{ captureRetryError || runtime.captureNotice.error }}</span>
            <button
              v-if="state.settings.clipboardCaptureEnabled"
              class="button small"
              :disabled="captureRetryBusy"
              @click="retryClipboard"
            >
              重试采集
            </button>
          </div>
          <button
            v-if="runtime?.app?.platform === 'darwin'"
            class="text-button"
            @click="native({ action: 'openNotificationSettings' })"
          >
            打开系统通知设置
          </button>
          <div class="setting-option shortcut-option" data-guide="capture-preview-settings">
            <label class="inline-check"
              ><input
                type="checkbox"
                :checked="captureValue('globalShortcutEnabled')"
                @change="saveCaptureSetting('globalShortcutEnabled', $event.target.checked)"
              />
              遇见采集快捷键</label
            >
            <p class="muted">
              {{ runtime?.app?.platform === "darwin" ? "⌘ Shift L" : "Ctrl Shift L" }}
            </p>
          </div>
        </section>
        <section class="settings-section" v-if="audio" v-show="panel === 'audio'">
          <h2>发音</h2>
          <form @submit.prevent="saveAudio">
            <div class="form-grid" data-guide="audio-preview">
              <label
                >默认提供者<select v-model="audio.provider" aria-label="发音提供者">
                  <option value="youdao">有道 · 单词发音</option>
                  <option value="microsoft">微软 · Edge 朗读</option>
                  <option value="custom">自定义 API</option>
                </select></label
              ><label
                >默认口音<select v-model="audio.accent">
                  <option value="us">美式</option>
                  <option value="uk">英式</option>
                </select></label
              ><label
                >微软声音<select v-model="audio.voice">
                  <option v-for="voice in audio.voices" :key="voice.id" :value="voice.id">
                    {{ voice.name }}
                  </option>
                </select></label
              ><label
                >语速<input
                  type="number"
                  v-model.number="audio.rate"
                  min="0.5"
                  max="2"
                  step="0.1" /></label
              ><label
                >音量<input
                  type="range"
                  v-model.number="audio.volume"
                  min="0"
                  max="1"
                  step="0.1" /></label
              ><label class="inline-check"
                ><input type="checkbox" v-model="audio.fallback" /> 有道与微软失败时互相回退</label
              >
            </div>
            <template v-if="audio.provider === 'custom'"
              ><label
                >API 地址<input
                  v-model="audio.custom.url"
                  aria-label="自定义 API 地址"
                  placeholder="https://example.com/audio?text={word}"
              /></label>
              <div class="form-grid">
                <label
                  >请求方式<select v-model="audio.custom.method">
                    <option>GET</option>
                    <option>POST</option>
                  </select></label
                ><label
                  >鉴权头 JSON<input
                    v-model="headers"
                    type="password"
                    autocomplete="new-password"
                    :placeholder="
                      audio.custom.hasSecret
                        ? '凭证已保存，留空继续使用'
                        : '{&quot;Authorization&quot;:&quot;Bearer …&quot;}'
                    "
                /></label>
              </div>
              <label v-if="audio.custom.method === 'POST'"
                >JSON 正文<textarea
                  v-model="audio.custom.body"
                  placeholder='{"input":"{word}","voice":"{voice}"}'
                /></label
              ><label class="inline-check" v-if="audio.custom.hasSecret"
                ><input type="checkbox" v-model="clearSecret" /> 保存时移除已存凭证</label
              >
              <p class="muted">
                支持 {word}、{accent}、{voice}。服务需直接返回 MP3、WAV 或
                OGG；鉴权头由系统加密保存。
              </p></template
            >
            <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
            <button class="button primary" :disabled="audioBusy">
              {{ audioBusy ? "保存中…" : "保存发音设置" }}
            </button>
          </form>
          <button class="text-button" @click="perform('audioSettings', { action: 'clearCache' })">
            清除发音缓存
          </button>
        </section>
        <ConnectionSettings v-if="panel === 'connection'" />
        <section class="settings-section" v-show="panel === 'data'">
          <h2>本机数据</h2>
          <button class="button" @click="native('showDataFolder')"> 打开资料目录 </button>
          <p class="muted">学习资料保存在本机，导入和导出将在后续版本开放。</p>
          <details class="data-location">
            <summary>资料位置与诊断</summary>
            <p class="muted break-word"> {{ runtime?.profile }} · {{ runtime?.dataDir }} </p>
            <div class="row">
              <button class="text-button" @click="native('restartCore')"> 重启本机核心</button
              ><button class="text-button" @click="native('showLogsFolder')"> 打开日志 </button>
            </div>
          </details>
        </section>
        <section class="settings-section teaching-settings" v-show="panel === 'teaching'">
          <h2>使用教学</h2>
          <p class="muted">
            从侧边栏开始，体验阅读与练习。目标和计划可跳过；重新开始只重置教学进度。
          </p>
          <div class="teaching-progress">
            <strong>{{ completed }} / {{ GUIDE_STEPS.length }} 项已完成</strong
            ><progress :value="completed" :max="GUIDE_STEPS.length" aria-label="教学进度" />
          </div>
          <div class="row">
            <button
              v-if="!state.guide.finishedAt"
              class="button primary"
              :disabled="busy"
              @click="emit('resume-guide')"
            >
              {{ state.guide.started ? "继续引导" : "开始引导教学" }}
            </button>
            <button class="button" :disabled="busy" @click="emit('restart-guide')">
              重新开始引导教学
            </button>
          </div>
          <ol class="teaching-checklist">
            <li
              v-for="(item, index) in GUIDE_STEPS"
              :key="item.id"
              :class="{ done: index < completed }"
            >
              <Icon :name="index < completed ? 'circle-check' : 'circle'" /><span>{{
                item.title
              }}</span>
            </li>
          </ol>
        </section>
        <section class="settings-section" v-show="panel === 'about'">
          <h2>词遇 Desktop {{ runtime?.app?.version || "开发版" }}</h2>
          <p>本机学习、离线词典和个人资料。</p>
          <p class="muted"> 插件通过本机配对连接；账号与云端同步将在 2.0.0 接入。 </p>
          <p class="muted">
            感谢 leximeet-dictionary、FSRS、Qwerty Learner、Aictionary、Pot、Maccy 与 Tabler Icons。
          </p>
        </section>
      </div>
    </div>
  </section>
</template>
