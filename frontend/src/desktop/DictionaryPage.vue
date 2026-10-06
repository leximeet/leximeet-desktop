<script setup>
import { ref, computed, onBeforeUnmount } from "vue";
import { api } from "../lib/api.js";
import Icon from "../components/Icon.vue";
const props = defineProps({ state: Object, busy: Boolean, run: Function });
const emit = defineEmits(["preview", "refresh", "plan"]);
const category = ref("exam"),
  search = ref(""),
  resource = ref(null),
  resourceError = ref("");
const catalogTitle = (title) => (title || "").replace(/\s*标签/g, "");
const catalogs = computed(() =>
  props.state.catalogs.filter((item) =>
    search.value.trim()
      ? `${item.title_zh} ${item.source}`.toLowerCase().includes(search.value.trim().toLowerCase())
      : item.category === category.value,
  ),
);
// 进入统一规划草稿，不提前改变当前目标。
const choose = (goal) => emit("plan", goal);
let disposed = false,
  generation = 0,
  timer;
function schedule() {
  clearTimeout(timer);
  if (!disposed) timer = setTimeout(status, resource.value?.busy ? 900 : 5000);
}
async function status() {
  const ticket = ++generation;
  try {
    const next = await api.dictionaryAction({ action: "status" });
    if (!disposed && ticket === generation) resource.value = next;
  } catch (failure) {
    if (!disposed && ticket === generation) resourceError.value = failure.message;
  } finally {
    if (ticket === generation) schedule();
  }
}
async function resourceAction(action, edition) {
  const ticket = ++generation;
  clearTimeout(timer);
  resourceError.value = "";
  try {
    const next = await api.dictionaryAction({
      action,
      ...(edition ? { edition } : {}),
    });
    if (!disposed && ticket === generation) {
      resource.value = next;
      emit("refresh");
    }
  } catch (failure) {
    if (!disposed && ticket === generation) resourceError.value = failure.message;
  } finally {
    if (ticket === generation) schedule();
  }
}
status();
onBeforeUnmount(() => {
  disposed = true;
  generation++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="d-page dictionary-page">
    <header class="page-heading">
      <div>
        <h1>词库中心</h1>
        <p>找到感兴趣的方向，再慢慢积累。</p>
      </div>
    </header>
    <section class="dictionary-resource" data-guide="dictionary-resource">
      <div>
        <h2>本地词典</h2>
        <p>
          leximeet-dictionary {{ state.dictionary.version }} ·
          {{ state.dictionary.edition === "full-text" ? "Full" : "Core" }} Text
        </p>
        <small>{{ state.dictionary.entryCount.toLocaleString() }} 词 · 离线文本</small>
      </div>
      <div class="row">
        <button
          class="button"
          :disabled="resource?.busy"
          v-if="state.dictionary.edition !== 'full-text'"
          @click="resourceAction('install', 'full-text')"
        >
          增量升级 Full · 45.31 MB</button
        ><button
          class="button"
          :disabled="resource?.busy"
          v-if="resource?.previous"
          @click="resourceAction('rollback')"
        >
          回退上一版本</button
        ><button class="text-button danger" v-if="resource?.busy" @click="resourceAction('cancel')">
          取消安装
        </button>
      </div>
      <p v-if="resource?.busy" class="muted" aria-live="polite">
        {{
          resource.progress.state === "indexing"
            ? `正在建立索引 ${resource.progress.entries} / ${resource.progress.total}`
            : `下载 ${((resource.progress.downloadedBytes || 0) / 1e6).toFixed(1)} / ${((resource.progress.deltaBytes || 0) / 1e6).toFixed(1)} MB`
        }}
      </p>
      <p class="error-banner" v-if="resourceError">{{ resourceError }}</p>
    </section>
    <div class="catalog-browser">
      <div class="catalog-toolbar">
        <div class="mode-tabs" data-guide="catalog-tabs" role="tablist" aria-label="词库分类">
          <button
            role="tab"
            :aria-selected="category === 'exam'"
            :class="{ active: category === 'exam' }"
            @click="category = 'exam'"
          >
            考试词库</button
          ><button
            role="tab"
            :aria-selected="category === 'subject'"
            :class="{ active: category === 'subject' }"
            @click="category = 'subject'"
          >
            学科词库
          </button>
        </div>
        <input v-model="search" placeholder="搜索全部词库…" aria-label="搜索全部词库" />
      </div>
      <div class="catalog-grid">
        <article
          v-for="catalog in catalogs"
          :key="catalog.catalog_id"
          :class="{ selected: state.profile.goal === catalog.catalog_id }"
        >
          <p class="eyebrow">
            {{ catalog.category === "exam" ? "考试词库" : "学科词库" }}
          </p>
          <h3>{{ catalogTitle(catalog.title_zh) }}</h3>
          <p>{{ catalog.entry_count.toLocaleString() }} 词</p>
          <div class="row">
            <button class="button small" @click="emit('preview', catalog.catalog_id)">
              预览词条</button
            ><button
              class="button small"
              :class="{ primary: state.profile.goal !== catalog.catalog_id }"
              :disabled="busy || state.profile.goal === catalog.catalog_id"
              :data-guide="state.profile.goal !== catalog.catalog_id ? 'goal-select' : undefined"
              @click="choose(catalog.catalog_id)"
            >
              {{ state.profile.goal === catalog.catalog_id ? "当前目标" : "设为学习目标" }}
            </button>
          </div>
          <details>
            <summary class="muted">数据来源</summary>
            <p>{{ catalog.source }}</p>
            <small>{{ catalog.method }}</small>
          </details>
        </article>
      </div>
      <section class="whole-dictionary">
        <Icon name="book-2" />
        <div>
          <h3>整本本地词典</h3>
          <p> {{ state.dictionary.entryCount.toLocaleString() }} 词 · 跟随活动 Core / Full 版本 </p>
        </div>
        <button
          class="button"
          :disabled="busy || state.profile.goal === 'dictionary'"
          @click="choose('dictionary')"
        >
          {{ state.profile.goal === "dictionary" ? "当前目标" : "设为学习目标" }}</button
        ><button class="text-button" @click="emit('preview', 'dictionary')"> 浏览词典 </button>
      </section>
      <p class="muted" v-if="!catalogs.length">没有找到匹配词库。</p>
    </div>
  </section>
</template>
