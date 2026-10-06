<script setup>
import {
  ref,
  reactive,
  computed,
  watch,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  nextTick,
} from "vue";
import { api } from "../lib/api.js";
import Icon from "../components/Icon.vue";
import WordCard from "./WordCard.vue";
import AppDialog from "./AppDialog.vue";
import { createLibraryQuery, createLibraryState, createLibrarySelection } from "./library-query.js";
import "./styles/library-actions.css";
const props = defineProps({
  state: Object,
  focusWord: Object,
  scope: String,
  catalogId: String,
  bookId: String,
  busy: Boolean,
  commandError: String,
  run: Function,
  audio: Object,
  speak: Function,
});
const emit = defineEmits(["capture"]);
const search = ref(""),
  learningStatus = ref("all"),
  readerOpen = ref(true),
  sort = ref("recent"),
  partOfSpeech = ref("all"),
  operation = ref(null),
  operationError = ref(""),
  operationPending = ref(false),
  targetBooks = ref([]);
const partsOfSpeech = [
  ["all", "全部词性"],
  ["noun", "名词"],
  ["verb", "动词"],
  ["adjective", "形容词"],
  ["adverb", "副词"],
  ["pronoun", "代词"],
  ["preposition", "介词"],
  ["conjunction", "连词"],
  ["determiner", "限定词"],
  ["interjection", "感叹词"],
];
const statusTabs = [
  { id: "all", label: "全部", hint: "全部单词" },
  { id: "new", label: "未学习", hint: "初始 10 分；安排到今日任务后开始学习" },
  { id: "learning", label: "学习中", hint: "已开始，尚未首次达到 20 分" },
  {
    id: "review",
    label: "待复习",
    hint: "初学已完成；自动复习还需等到期，主动练习随时可用",
  },
  {
    id: "mastered",
    label: "已熟悉",
    hint: "曾到 30 分，当前仍在休息期；降到 20 后回到复习池",
  },
  { id: "unfamiliar", label: "不熟悉", hint: "当前 0 分；保留原有学习阶段" },
];
const model = reactive(createLibraryState());
const query = createLibraryQuery({ state: model, query: api.desktopQuery });
const selection = createLibrarySelection(model);
const allChecked = computed(
  () => model.words.length > 0 && model.checkedIds.length === model.words.length,
);
const someChecked = computed(() => model.checkedIds.length > 0 && !allChecked.value);
const blocked = computed(() => props.busy || operationPending.value);
const books = computed(() => props.state.books.filter((item) => !item.role));
const title = computed(
  () =>
    ({ trash: "回收站", dictionary: "本地词典", library: "我的词库" })[props.scope] ||
    (props.scope === "book"
      ? props.state.books.find((item) => item.id === props.bookId)?.name
      : props.state.catalogs
          .find((item) => item.catalog_id === props.catalogId)
          ?.title_zh?.replace(/\s*标签/g, "")) ||
    "词库预览",
);
const activeRow = computed(() =>
  Math.max(
    0,
    model.words.findIndex((word) => word.id === model.selectedId),
  ),
);
const filter = () => ({
  kind: "words",
  scope: props.scope || "library",
  catalogId: props.catalogId || undefined,
  bookId: props.bookId || undefined,
  search: search.value,
  learningStatus: learningStatus.value,
  sort: sort.value,
  partOfSpeech: partOfSpeech.value,
});
const status = (word) =>
  word.deletedAt && props.scope === "trash"
    ? "已回收"
    : word.familiarity?.label || { new: "未学习", mastered: "已熟悉" }[word.status] || "学习中";
let timer,
  focusing = false,
  active = true,
  mountedOnce = false;
const load = (offset = model.offset) => query.load(filter(), offset);
watch(
  () => [props.scope, props.catalogId, props.bookId],
  () => {
    clearTimeout(timer);
    query.invalidate({ clear: true });
    search.value = "";
    learningStatus.value = "all";
    model.offset = 0;
    readerOpen.value = true;
    if (active) load(0);
  },
  { immediate: true },
);
watch(
  () => props.state,
  () => {
    if (active) load();
  },
);
watch(search, () => {
  clearTimeout(timer);
  if (focusing) return;
  query.invalidate({ clear: true });
  timer = setTimeout(() => load(0), 200);
});
watch([sort, partOfSpeech], () => {
  clearTimeout(timer);
  if (focusing) return;
  query.invalidate({ clear: true });
  model.offset = 0;
  if (active) load(0);
});
// 连接端导航仍走普通查询，不能把插件传来的内容直接拼入阅读器。
watch(
  () => props.focusWord,
  async (request) => {
    if (!request?.wordId || !active) return;
    clearTimeout(timer);
    query.invalidate({ clear: true });
    focusing = true;
    learningStatus.value = "all";
    // 插件直接定位词条时不能沿用排除该词的词性筛选。
    partOfSpeech.value = "all";
    search.value = request.searchTerm || request.wordId;
    readerOpen.value = true;
    await nextTick();
    focusing = false;
    if (!active || props.focusWord !== request) return;
    await load(0);
    if (props.focusWord === request) await query.select(request.wordId);
  },
  { flush: "post" },
);
function changeStatus(value) {
  if (learningStatus.value === value) return;
  learningStatus.value = value;
  clearTimeout(timer);
  query.invalidate({ clear: true });
  model.offset = 0;
  if (active) load(0);
}
// 分段筛选保持一个 Tab 停靠点，方向键可选择并加载相应结果。
function moveStatus(event, index) {
  const next = {
    ArrowRight: (index + 1) % statusTabs.length,
    ArrowLeft: (index + statusTabs.length - 1) % statusTabs.length,
    Home: 0,
    End: statusTabs.length - 1,
  }[event.key];
  if (next === undefined) return;
  event.preventDefault();
  changeStatus(statusTabs[next].id);
  event.currentTarget.parentElement.children[next]?.focus();
}
async function select(id) {
  readerOpen.value = true;
  await query.select(id);
}
async function change(payload) {
  if (await props.run(payload)) await load();
}
function pageTo(offset) {
  selection.clear();
  load(offset);
}
function requestTrash(word) {
  operationError.value = "";
  // 对话框冻结本次意图，后台快照或列表排序不能把确认对象替换成另一个词。
  operation.value = { kind: "trash", wordIds: [word.id], label: word.word };
}
function requestSelected(kind) {
  const wordIds = selection.ids();
  if (!wordIds.length || blocked.value) return;
  operationError.value = "";
  targetBooks.value = [];
  operation.value = { kind, wordIds, label: `${wordIds.length} 个单词` };
}
async function confirmOperation() {
  const current = operation.value;
  if (!current || blocked.value || (current.kind === "books" && !targetBooks.value.length)) return;
  operationPending.value = true;
  operationError.value = "";
  try {
    const payload =
      current.kind === "books"
        ? {
            action: "bulkAddToBooks",
            wordIds: [...current.wordIds],
            bookIds: [...targetBooks.value],
          }
        : current.wordIds.length === 1
          ? { action: "trash", wordId: current.wordIds[0] }
          : { action: "bulkTrash", wordIds: [...current.wordIds] };
    const success = await props.run(
      payload,
      current.kind === "books" ? "已加入单词本" : "已移到回收站",
    );
    if (!success) {
      operationError.value = props.commandError || "操作未完成，请重试。";
      return;
    }
    selection.clear();
    if (operation.value === current) operation.value = null;
    if (active) await load();
  } catch (failure) {
    operationError.value = failure.message || "操作未完成，请重试。";
  } finally {
    operationPending.value = false;
  }
}
async function restoreSelected() {
  const wordIds = selection.ids();
  if (!wordIds.length || blocked.value) return;
  operationPending.value = true;
  try {
    if (await props.run({ action: "bulkRestore", wordIds }, "词条已恢复")) {
      selection.clear();
      if (active) await load();
    }
  } finally {
    operationPending.value = false;
  }
}
function move(event, index) {
  if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
  event.preventDefault();
  const next = Math.max(
    0,
    Math.min(model.words.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)),
  );
  select(model.words[next].id);
  event.currentTarget.parentElement.children[next]?.focus();
}
onActivated(() => {
  active = true;
  query.activate();
  if (mountedOnce) load();
  mountedOnce = true;
});
onDeactivated(() => {
  active = false;
  operation.value = null;
  clearTimeout(timer);
  query.deactivate();
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  query.deactivate();
});
</script>
<template>
  <section class="d-library" :class="{ 'reader-closed': !readerOpen }">
    <header
      class="page-heading"
      :data-guide="scope === 'trash' && model.words.length ? 'trash-view' : undefined"
    >
      <div>
        <h1>{{ title }}</h1>
        <p>
          {{ model.total.toLocaleString() }} 词<span v-if="scope === 'trash'">
            · 恢复词条后继续阅读</span
          >
        </p>
      </div>
      <div class="row library-actions">
        <button
          class="icon-button"
          :aria-label="readerOpen ? '收起词卡' : '展开词卡'"
          :aria-pressed="readerOpen"
          @click="readerOpen = !readerOpen"
        >
          <Icon name="layout-sidebar" />
        </button>
        <button v-if="scope !== 'trash'" class="button primary" @click="emit('capture', 'capture')">
          <Icon name="plus" />记录遇见
        </button>
      </div>
    </header>
    <div class="library-toolbar">
      <div
        v-if="scope !== 'trash'"
        class="library-status-tabs"
        role="tablist"
        aria-label="单词状态"
      >
        <button
          v-for="(tab, index) in statusTabs"
          :key="tab.id"
          role="tab"
          :id="`word-status-${tab.id}`"
          aria-controls="library-results"
          :aria-selected="learningStatus === tab.id"
          :tabindex="learningStatus === tab.id ? 0 : -1"
          :title="tab.hint"
          @click="changeStatus(tab.id)"
          @keydown="moveStatus($event, index)"
        >
          {{ tab.label }}
        </button>
      </div>
      <span v-else class="muted">已回收的单词</span>
      <label class="search-field"
        ><Icon name="search" /><input
          v-model="search"
          aria-label="搜索单词"
          data-guide="library-search"
          placeholder="搜索单词或释义…" /><button
          v-if="search"
          class="icon-button"
          aria-label="清空搜索"
          @click="search = ''"
        >
          <Icon name="x" /></button
      ></label>
    </div>
    <div class="library-query-controls">
      <div class="library-query-filters">
        <label>
          <span class="sr-only">词库排序</span>
          <select v-model="sort" aria-label="词库排序" :disabled="blocked">
            <option value="recent">最近更新</option>
            <option value="alphabetical">按字母排序</option>
            <option value="source">词书顺序</option>
          </select>
        </label>
        <label>
          <span class="sr-only">筛选词性</span>
          <select v-model="partOfSpeech" aria-label="筛选词性" :disabled="blocked">
            <option v-for="item in partsOfSpeech" :key="item[0]" :value="item[0]">{{
              item[1]
            }}</option>
          </select>
        </label>
      </div>
      <div class="library-bulk-actions" role="group" aria-label="单词批量操作">
        <span class="muted" aria-live="polite">已选 {{ model.checkedIds.length }} 词</span>
        <button
          class="text-button"
          :disabled="!model.checkedIds.length || blocked"
          @click="selection.clear()"
          >取消选择</button
        >
        <button
          v-if="scope !== 'trash'"
          class="button small"
          :disabled="!model.checkedIds.length || blocked || model.loading"
          @click="requestSelected('books')"
          >放入单词本</button
        >
        <button
          v-if="scope !== 'trash'"
          class="button small danger"
          :disabled="!model.checkedIds.length || blocked || model.loading"
          @click="requestSelected('trash')"
          >移到回收站</button
        >
        <button
          v-else
          class="button small"
          :disabled="!model.checkedIds.length || blocked || model.loading"
          @click="restoreSelected"
          >恢复所选</button
        >
      </div>
    </div>
    <p v-if="model.error" class="error-banner" role="alert">
      {{ model.error }}
      <button class="text-button" @click="load()">重试</button>
    </p>
    <div class="list-card-split">
      <section
        id="library-results"
        class="d-word-list"
        :role="scope !== 'trash' ? 'tabpanel' : undefined"
        :aria-labelledby="scope !== 'trash' ? `word-status-${learningStatus}` : undefined"
        data-guide="word-list"
        aria-label="单词列表"
        :aria-busy="model.loading"
      >
        <div class="word-table-scroll">
          <table class="word-table library-table">
            <colgroup>
              <col class="col-select" />
              <col class="col-word" />
              <col />
              <col class="col-state" />
              <col class="col-next" />
            </colgroup>
            <thead>
              <tr>
                <th class="selection-column">
                  <input
                    type="checkbox"
                    aria-label="选择当前页全部单词"
                    :checked="allChecked"
                    :indeterminate.prop="someChecked"
                    :disabled="!model.words.length || model.loading || blocked"
                    @change="selection.setPage($event.target.checked)"
                  />
                </th>
                <th>单词</th>
                <th>释义</th>
                <th>状态</th>
                <th><span class="sr-only">阅读</span></th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(word, index) in model.words"
                :key="word.id"
                :class="{ selected: model.selectedId === word.id }"
                :tabindex="index === activeRow ? 0 : -1"
                :aria-selected="model.selectedId === word.id"
                @click="select(word.id)"
                @keydown.enter="select(word.id)"
                @keydown="move($event, index)"
              >
                <td class="selection-column" @click.stop>
                  <input
                    type="checkbox"
                    :aria-label="`选择单词 ${word.word}`"
                    :checked="model.checkedIds.includes(word.id)"
                    :disabled="model.loading || blocked"
                    @change="selection.toggle(word.id, $event.target.checked)"
                    @keydown.stop
                  />
                </td>
                <td class="word-column" :title="word.word">{{ word.word }}</td>
                <td class="meaning-column" :title="word.meaning">
                  {{ word.meaning }}
                </td>
                <td>
                  <span class="word-status" :class="word.learningStatus || word.status">{{
                    status(word)
                  }}</span>
                </td>
                <td><Icon name="chevron-right" /></td>
              </tr>
            </tbody>
          </table>
          <div
            class="empty"
            v-if="!model.words.length"
            :data-guide="scope === 'trash' ? 'trash-view' : undefined"
          >
            <Icon :name="search ? 'search' : 'book-2'" />
            <h2>
              {{
                model.loading
                  ? "正在查找…"
                  : search || partOfSpeech !== "all"
                    ? "没有匹配的单词"
                    : learningStatus !== "all"
                      ? "暂无这类单词"
                      : scope === "trash"
                        ? "回收站是空的"
                        : "从第一次遇见开始"
              }}
            </h2>
            <p v-if="!model.loading">
              {{
                search || partOfSpeech !== "all"
                  ? "换一个关键词或词性。"
                  : learningStatus !== "all"
                    ? "练习后状态会自动更新，也可以查看全部单词。"
                    : scope === "trash"
                      ? "移除的个人词条会保留在这里。"
                      : "记录阅读中遇见的词，慢慢积累自己的词库。"
              }}
            </p>
            <button
              v-if="learningStatus !== 'all' && !model.loading"
              class="button small"
              @click="changeStatus('all')"
            >
              查看全部单词
            </button>
            <button v-if="search" class="button small" @click="search = ''"> 清空搜索</button
            ><button
              v-if="partOfSpeech !== 'all'"
              class="button small"
              @click="partOfSpeech = 'all'"
              >显示全部词性</button
            ><button
              v-else-if="scope !== 'trash' && learningStatus === 'all' && !search && !model.loading"
              class="button"
              @click="emit('capture', 'capture')"
            >
              记录遇见
            </button>
          </div>
        </div>
        <div class="pagination">
          <button
            class="icon-button"
            aria-label="上一页"
            :disabled="!model.offset || model.loading"
            @click="pageTo(Math.max(0, model.offset - 40))"
          >
            <Icon name="arrow-left" /></button
          ><span
            >{{ model.total ? model.offset + 1 : 0 }}–{{
              Math.min(model.offset + 40, model.total)
            }}
            / {{ model.total.toLocaleString() }}</span
          ><button
            class="icon-button"
            aria-label="下一页"
            :disabled="model.offset + 40 >= model.total || model.loading"
            @click="pageTo(model.offset + 40)"
          >
            <Icon name="arrow-right" />
          </button>
        </div>
      </section>
      <!-- 词卡组件持续存在，搜索清空与跨页后仍保留按词条保存的未提交草稿。 -->
      <section class="d-detail-column" v-show="readerOpen" :aria-busy="model.detailLoading">
        <div class="reader-toolbar">
          <span>{{
            model.selected
              ? `${activeRow + 1 + model.offset} / ${model.total.toLocaleString()}`
              : "词条详情"
          }}</span
          ><button class="icon-button" aria-label="关闭词卡" @click="readerOpen = false">
            <Icon name="x" />
          </button>
        </div>
        <div class="reader-scroll">
          <p v-if="model.detailLoading && !model.selected" class="empty"> 正在载入词条… </p>
          <button
            v-if="scope === 'trash' && model.selected"
            class="button primary restore-word"
            data-guide="word-restore"
            :disabled="busy"
            @click="change({ action: 'restore', wordId: model.selected.id })"
          >
            恢复这个词条
          </button>
          <WordCard
            :word="model.selected"
            :state="state"
            :busy="busy"
            :audio="audio"
            @command="change"
            @request-trash="requestTrash"
            @speak="speak"
          />
        </div>
      </section>
    </div>
    <AppDialog
      v-if="operation"
      :title="operation.kind === 'books' ? '放入单词本' : '移到回收站？'"
      :busy="blocked"
      @close="operation = null"
    >
      <template v-if="operation.kind === 'books'">
        <p>{{ operation.label }} · 可选择多个单词本，已有归类会保留。</p>
        <fieldset class="library-book-picker">
          <legend class="sr-only">选择单词本</legend>
          <label v-for="book in books" :key="book.id" class="inline-check">
            <input
              type="checkbox"
              v-model="targetBooks"
              :value="book.id"
              :aria-label="`放入单词本 ${book.name}`"
              :disabled="blocked"
            />{{ book.name }}
          </label>
          <p v-if="!books.length" class="muted">先从侧边栏创建一个单词本。</p>
        </fieldset>
      </template>
      <p v-else>将 {{ operation.label }} 移到回收站，可在回收站恢复。</p>
      <p v-if="operationError" class="error-banner" role="alert">{{ operationError }}</p>
      <footer>
        <button class="button" :disabled="blocked" @click="operation = null">取消</button>
        <button
          :class="['button', operation.kind === 'books' ? 'primary' : 'danger']"
          :disabled="blocked || (operation.kind === 'books' && !targetBooks.length)"
          @click="confirmOperation"
          >{{ operation.kind === "books" ? "确认放入" : "确认移到回收站" }}</button
        >
      </footer>
    </AppDialog>
  </section>
</template>
