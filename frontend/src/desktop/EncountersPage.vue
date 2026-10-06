<script setup>
import { ref, watch, onBeforeUnmount } from "vue";
import { api } from "../lib/api.js";
import ContextText from "./ContextText.vue";
const props = defineProps({ state: Object });
const emit = defineEmits(["capture"]);
const search = ref(""),
  from = ref(""),
  to = ref(""),
  offset = ref(0),
  rows = ref([]),
  total = ref(0),
  error = ref(""),
  loading = ref(false);
let sequence = 0,
  timer;
async function load() {
  const ticket = ++sequence;
  loading.value = true;
  if (from.value && to.value && from.value > to.value) {
    error.value = "开始日期不能晚于结束日期";
    loading.value = false;
    return;
  }
  try {
    const result = await api.desktopQuery({
      kind: "encounters",
      search: search.value,
      from: from.value,
      to: to.value,
      offset: offset.value,
      limit: 40,
    });
    if (ticket !== sequence) return;
    rows.value = result.encounters;
    total.value = result.total;
    error.value = "";
  } catch (failure) {
    if (ticket === sequence) error.value = failure.message;
  } finally {
    if (ticket === sequence) loading.value = false;
  }
}
function quick(days) {
  const local = (date) =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  from.value = local(start);
  to.value = local(new Date());
}
watch([search, from, to], () => {
  sequence++;
  offset.value = 0;
  clearTimeout(timer);
  timer = setTimeout(load, 200);
});
watch(() => props.state, load);
load();
onBeforeUnmount(() => {
  sequence++;
  clearTimeout(timer);
});
</script>
<template>
  <section class="d-page">
    <header class="page-heading">
      <div>
        <h1>遇见记录</h1>
        <p>留住语境，记住每一次重逢。</p>
      </div>
      <button class="button primary" data-guide="capture-open" @click="emit('capture')">
        记录新的遇见
      </button>
    </header>
    <div class="encounter-filters">
      <input v-model="search" aria-label="搜索遇见记录" placeholder="搜索单词或语境…" /><input
        type="date"
        v-model="from"
        aria-label="遇见起始日期"
      /><input type="date" v-model="to" aria-label="遇见结束日期" /><button
        class="button small"
        @click="quick(1)"
        >今天</button
      ><button class="button small" @click="quick(7)">近 7 天</button
      ><button
        class="text-button"
        @click="
          from = '';
          to = '';
        "
      >
        全部
      </button>
    </div>
    <p v-if="error" role="alert" class="error-banner">{{ error }}</p>
    <ol class="encounter-list">
      <li v-for="item in rows" :key="item.id">
        <div class="encounter-heading">
          <strong class="encounter-word">{{ item.word }}</strong>
          <time :datetime="item.createdAt">{{
            new Date(item.createdAt).toLocaleString("zh-CN", {
              year: "numeric",
              month: "2-digit",
              day: "2-digit",
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            })
          }}</time>
        </div>
        <blockquote class="encounter-context">
          <ContextText :text="item.context" :word="item.word" />
        </blockquote>
        <p class="encounter-source muted">
          {{ item.sourceTitle || "手动语境"
          }}<span v-if="item.sourceUrl"> · {{ item.sourceUrl }}</span>
        </p>
      </li>
    </ol>
    <div class="empty" v-if="!rows.length && !loading">
      <h2>
        {{ search || from || to ? "没有匹配的遇见" : "下一次遇见，从这里开始" }}
      </h2>
      <p>
        {{
          search || from || to
            ? "调整关键词或时间范围再试试。"
            : "记录阅读中的单词和原句，保留理解它的线索。"
        }}
      </p>
    </div>
    <div class="pagination">
      <button
        class="button small"
        :disabled="offset === 0 || loading"
        @click="
          offset = Math.max(0, offset - 40);
          load();
        "
      >
        上一页</button
      ><span>{{ total }} 条</span
      ><button
        class="button small"
        :disabled="offset + 40 >= total || loading"
        @click="
          offset += 40;
          load();
        "
      >
        下一页
      </button>
    </div>
  </section>
</template>
