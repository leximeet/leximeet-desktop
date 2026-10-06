<script setup>
import { computed, ref, watch, onMounted, onBeforeUnmount, nextTick } from "vue";
import Icon from "../components/Icon.vue";
import DesktopSidebar from "./DesktopSidebar.vue";
import { useDesktop } from "./useDesktop.js";
import OnboardingGuide from "./OnboardingGuide.vue";
import TodayPage from "./TodayPage.vue";
import PlanPage from "./PlanPage.vue";
import DictionaryPage from "./DictionaryPage.vue";
import InsightsPage from "./InsightsPage.vue";
import AppDialog from "./AppDialog.vue";
import LibraryPage from "./LibraryPage.vue";
import EncountersPage from "./EncountersPage.vue";
import PracticePage from "./PracticePage.vue";
import SettingsPage from "./SettingsPage.vue";
import { currentGuideStep } from "./guide-steps.js";
const desktop = useDesktop();
const {
  state,
  runtime,
  busy,
  error,
  notice,
  loading,
  audio,
  audioSettings,
  refresh,
  command,
  practiceFeedback,
  native,
  settings,
  speak,
  stopAudio,
} = desktop;
const page = ref("today"),
  scope = ref("library"),
  catalogId = ref(""),
  bookId = ref(""),
  newBook = ref(false),
  bookName = ref(""),
  confirmedDelete = ref("");
const systemDark = ref(matchMedia("(prefers-color-scheme:dark)").matches);
const dark = computed(
  () =>
    state.value?.settings.theme === "dark" ||
    (state.value?.settings.theme !== "light" && systemDark.value),
);
watch(dark, (value) => (document.documentElement.dataset.theme = value ? "dark" : "light"), {
  immediate: true,
});
const practiceRange = ref("library");
function startToday() {
  practiceRange.value = state.value.queue.tasks.length ? "today" : "library";
  navigate("practice");
}
const navigation = [
  ["today", "今日学习", "sun"],
  ["plan", "学习规划", "list-check"],
  ["practice", "练习中心", "keyboard"],
  ["insights", "学习洞察", "target"],
  ["library", "我的词库", "book-2"],
  ["encounters", "遇见记录", "history"],
  ["dictionary", "词库中心", "folder"],
];
const navigationGroups = [
  { label: "学习", items: navigation.slice(0, 4) },
  { label: "资料", items: navigation.slice(4) },
];
const viewTitle = computed(() => {
  if (page.value === "library" && scope.value === "trash") return "回收站";
  if (page.value === "library" && scope.value === "dictionary") return "本地词典";
  if (page.value === "library" && scope.value === "book")
    return state.value?.books.find((item) => item.id === bookId.value)?.name || "单词本";
  return navigation.find((item) => item[0] === page.value)?.[1] || "设置";
});
async function navigate(target) {
  stopAudio();
  page.value = target;
  if (target === "library") {
    scope.value =
      currentGuideStep(state.value?.guide)?.id === "audio" && !state.value?.insights.manualWords
        ? "dictionary"
        : "library";
    catalogId.value = "";
    bookId.value = "";
  }
}
async function searchWords() {
  stopAudio();
  page.value = "library";
  scope.value = "dictionary";
  catalogId.value = "";
  bookId.value = "";
  await nextTick();
  document.querySelector('[data-guide="library-search"]')?.focus();
}
async function helpGuide() {
  if (
    await command({
      action: state.value?.guide.finishedAt ? "guideReset" : "guideResume",
    })
  ) {
    await navigate(currentGuideStep(state.value.guide)?.page || "today");
  }
}
async function restartGuide() {
  if (await command({ action: "guideReset" })) await navigate("today");
}
// 只处理当前窗口的快捷键，不注册全局按键，也不截获输入框里的普通打字。
function shortcut(event) {
  if (document.querySelector(".app-dialog[open]")) return;
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.isComposing) return;
  if (event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchWords();
  } else if (event.key === ",") {
    event.preventDefault();
    navigate("settings");
  } else if (/^[1-7]$/.test(event.key)) {
    event.preventDefault();
    navigate(navigation[Number(event.key) - 1][0]);
  }
}
function preview(id) {
  page.value = "library";
  scope.value = id === "dictionary" ? "dictionary" : "catalog";
  catalogId.value = id === "dictionary" ? "" : id;
  bookId.value = "";
}
function openBook(id) {
  page.value = "library";
  scope.value = "book";
  bookId.value = id;
  catalogId.value = "";
}
async function openCapture(word = "", mode = "capture") {
  try {
    await window.leximeet.captureAction({ action: "open", word, mode });
  } catch (failure) {
    error.value = failure.message;
  }
}
async function createBook() {
  if (await command({ action: "createBook", name: bookName.value }, "单词本已创建")) {
    bookName.value = "";
    newBook.value = false;
  }
}
async function removeBook(id) {
  if (confirmedDelete.value !== id) {
    confirmedDelete.value = id;
    return;
  }
  if (await command({ action: "deleteBook", bookId: id })) {
    confirmedDelete.value = "";
    if (bookId.value === id) {
      scope.value = "library";
      bookId.value = "";
    }
  }
}
let disposed = false,
  offChanged,
  offNavigate,
  refreshTimer,
  reminderTimer;
const planningSource = ref("");
const focusWord = ref(null);
function choosePlanning(goal) {
  planningSource.value = goal;
  navigate("plan");
}
const media = matchMedia("(prefers-color-scheme:dark)");
function closeMenus(event) {
  for (const menu of document.querySelectorAll(".action-menu[open]"))
    if (!menu.contains(event.target)) menu.open = false;
}
const changeTheme = (event) => (systemDark.value = event.matches);
onMounted(async () => {
  document.addEventListener("keydown", shortcut);
  document.addEventListener("pointerdown", closeMenus);
  media.addEventListener("change", changeTheme);
  await refresh();
  if (disposed) return;
  offChanged = window.leximeet?.onDataChanged(() => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, 300);
  });
  offNavigate = window.leximeet?.onNavigate(async (request) => {
    if (disposed || state.value?.guide.active || document.querySelector(".app-dialog[open]"))
      return false;
    await navigate(request.page);
    if (disposed) return false;
    if (request.page === "library" && request.wordId) {
      scope.value = request.scope;
      focusWord.value = {
        wordId: request.wordId,
        searchTerm: request.searchTerm,
        sequence: Date.now(),
      };
    }
    await nextTick();
    return !disposed && page.value === request.page;
  });
  // 定时刷新 Core 的阶段与到期投影。提醒投递集中在 Main，Renderer 不另发一套提醒。
  reminderTimer = setInterval(() => {
    if (state.value) refresh();
  }, 60000);
});
onBeforeUnmount(() => {
  disposed = true;
  document.removeEventListener("keydown", shortcut);
  document.removeEventListener("pointerdown", closeMenus);
  media.removeEventListener("change", changeTheme);
  offChanged?.();
  offNavigate?.();
  clearTimeout(refreshTimer);
  clearInterval(reminderTimer);
});
</script>
<template>
  <div
    class="desktop-shell"
    :class="{
      'is-macos': runtime?.app?.platform === 'darwin',
      'guide-active': state?.guide.active && state?.guide.started && !state?.guide.finishedAt,
    }"
  >
    <header class="d-titlebar" role="toolbar" aria-label="窗口工具栏">
      <div class="window-location">
        <span>词遇</span><span class="window-divider">/</span><strong>{{ viewTitle }}</strong>
      </div>
      <div class="window-actions">
        <small class="workspace-badge" v-if="runtime && runtime.profile !== 'local'"
          >隔离验收</small
        >
        <button
          class="window-search"
          aria-label="搜索整个词典"
          title="搜索整个词典 · ⌘ K / Ctrl K"
          @click="searchWords"
        >
          <Icon name="search" /><span>搜索词典</span
          ><kbd>{{ runtime?.app?.platform === "darwin" ? "⌘ K" : "Ctrl K" }}</kbd>
        </button>
        <button
          class="icon-button"
          aria-label="快速记录遇见"
          title="记录一次遇见"
          @click="openCapture()"
        >
          <Icon name="plus" />
        </button>
        <button
          class="icon-button"
          data-guide="guide-help"
          aria-label="使用教学"
          title="使用教学"
          @click="helpGuide"
        >
          <Icon name="info-circle" />
        </button>
        <button
          class="icon-button"
          :aria-label="dark ? '切换明亮主题' : '切换黑暗主题'"
          @click="settings({ theme: dark ? 'light' : 'dark' })"
        >
          <Icon :name="dark ? 'sun' : 'moon'" />
        </button>
      </div>
    </header>
    <div class="d-shell-body">
      <DesktopSidebar
        :state="state"
        :page="page"
        :scope="scope"
        :book-id="bookId"
        :dark="dark"
        :navigation-groups="navigationGroups"
        @navigate="navigate"
        @create-book="newBook = true"
        @open-book="openBook"
        @remove-book="removeBook"
        @trash="
          page = 'library';
          scope = 'trash';
          bookId = '';
          catalogId = '';
        "
      />
      <main class="d-main">
        <div class="d-error" v-if="error" role="alert">
          <span>{{ error }}</span
          ><button class="text-button" @click="refresh">重试连接</button>
        </div>
        <template v-if="state"
          ><OnboardingGuide
            :state="state"
            :busy="busy"
            :page="page"
            :scope="scope"
            :audio="audio"
            @command="command"
            @navigate="navigate"
          />
          <TodayPage
            v-if="page === 'today'"
            :state="state"
            :busy="busy"
            :run="command"
            :speak="speak"
            @navigate="navigate"
            @start="startToday"
            @capture="openCapture()"
          />
          <PlanPage
            v-else-if="page === 'plan'"
            :source="planningSource"
            @source-used="planningSource = ''"
            :state="state"
            :busy="busy"
            :run="command"
          />
          <DictionaryPage
            v-else-if="page === 'dictionary'"
            :state="state"
            :busy="busy"
            :run="command"
            @preview="preview"
            @plan="choosePlanning"
            @refresh="refresh"
          />
          <!-- 词库离开后保留阅读位置与笔记草稿；资料仍以 Core 的版本为准。 -->
          <KeepAlive
            ><LibraryPage
              v-if="page === 'library'"
              :state="state"
              :focus-word="focusWord"
              :scope="scope"
              :catalog-id="catalogId"
              :book-id="bookId"
              :busy="busy"
              :command-error="error"
              :run="command"
              :speak="speak"
              :audio="audio"
              @capture="openCapture('', $event)"
          /></KeepAlive>
          <EncountersPage v-if="page === 'encounters'" :state="state" @capture="openCapture()" />
          <PracticePage
            v-if="page === 'practice'"
            :state="state"
            :record-feedback="practiceFeedback"
            :speak="speak"
            :audio="audio"
            :initial-range="practiceRange"
            :stop-audio="stopAudio"
          />
          <KeepAlive
            ><SettingsPage
              v-if="page === 'settings'"
              :state="state"
              :runtime="runtime"
              :audio-settings="audioSettings"
              :busy="busy"
              :save-settings="settings"
              :native="native"
              :command="command"
              :refresh="refresh"
              @restart-guide="restartGuide"
              @resume-guide="helpGuide"
              @audio-saved="
                audioSettings = $event;
                notice = '发音设置已保存';
              "
          /></KeepAlive>
          <InsightsPage v-if="page === 'insights'" :state="state" />
        </template>
        <div class="empty" v-else>
          <Icon name="book-2" />
          <h2>{{ loading ? "正在准备本机资料…" : "本机资料尚未连接" }}</h2>
          <button class="button" @click="native('restartCore')"> 重启核心并重试 </button>
        </div>
      </main>
    </div>
    <AppDialog v-if="newBook" title="创建单词本" :busy="busy" @close="newBook = false">
      <form @submit.prevent="createBook">
        <label
          >名称<input
            v-model="bookName"
            required
            maxlength="80"
            aria-label="单词本名称"
            placeholder="例如：技术阅读"
            autofocus
        /></label>
        <p v-if="error" class="error-banner" role="alert">{{ error }}</p>
        <footer>
          <button type="button" class="button" :disabled="busy" @click="newBook = false">
            取消</button
          ><button class="button primary" :disabled="busy">创建</button>
        </footer>
      </form>
    </AppDialog>
    <AppDialog
      v-if="confirmedDelete"
      title="移除这个单词本？"
      :busy="busy"
      @close="confirmedDelete = ''"
    >
      <p>只移除单词本，单词、语境和学习记录会保留。</p>
      <footer>
        <button class="button" :disabled="busy" @click="confirmedDelete = ''"> 取消</button
        ><button class="button danger" :disabled="busy" @click="removeBook(confirmedDelete)">
          确认移除
        </button>
      </footer>
    </AppDialog>
    <footer class="d-statusbar">
      <span class="status-state"
        ><i :class="{ ready: state }" />{{ state ? "本机资料已就绪" : "正在连接本机资料" }}</span
      ><span aria-live="polite" role="status">{{
        audio.state === "loading"
          ? "正在加载发音"
          : audio.state === "playing"
            ? `正在播放 · ${audio.provider}`
            : notice || "资料仅保存在本机"
      }}</span
      ><span
        >{{ state?.dictionary.edition === "full-text" ? "Full Text" : "Core Text" }} ·
        {{ state?.dictionary.entryCount?.toLocaleString() || "—" }} 词</span
      >
      <button v-if="notice" class="icon-button" aria-label="关闭提示" @click="notice = ''">
        <Icon name="x" />
      </button>
    </footer>
  </div>
</template>
