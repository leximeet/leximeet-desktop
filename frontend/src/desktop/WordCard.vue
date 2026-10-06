<script setup>
import { ref, computed, watch } from "vue";
import Icon from "../components/Icon.vue";
import ContextText from "./ContextText.vue";
import WordMeaning from "./WordMeaning.vue";
import { visibleCardSections } from "../lib/card-layout.js";
import { useWordDraft } from "./useWordDraft.js";
const props = defineProps({
  word: Object,
  state: Object,
  busy: Boolean,
  audio: Object,
});
const emit = defineEmits(["command", "speak", "request-trash"]);
const { note, selectedBooks, conflict, save, reset, dirty } = useWordDraft(
  () => props.word,
  (payload) => emit("command", payload),
);
const tab = ref("context"),
  editing = ref(false),
  expandedContexts = ref(false);
const entry = computed(() => props.word?.entry);
const sections = computed(() => visibleCardSections(props.state.settings.cardLayout));
const has = (section) => sections.value.includes(section);
const contexts = computed(() => {
  const items = props.word?.encounters || [];
  return has("encounterList") || expandedContexts.value ? items : items.slice(0, 1);
});
const senses = computed(() => entry.value?.senses || []);
const summary = computed(
  () =>
    senses.value
      .slice(0, 2)
      .map((sense) => sense.short_gloss)
      .filter(Boolean)
      .join("；") ||
    props.word?.meaning ||
    "暂无释义",
);
const phonetics = computed(() =>
  [
    ...new Set(
      (entry.value?.pronunciations || [])
        .filter((item) => item.notation === "IPA")
        .map((item) => item.text),
    ),
  ].slice(0, 2),
);
const tabs = computed(() => [
  ...(has("evidence") || has("encounterList") ? [{ id: "context", name: "语境" }] : []),
  { id: "meaning", name: "释义" },
  ...(has("note") || has("collections") || has("reviewSummary")
    ? [{ id: "records", name: "记录" }]
    : []),
]);
watch(
  tabs,
  () => {
    if (!tabs.value.some((item) => item.id === tab.value)) tab.value = "meaning";
  },
  { immediate: true },
);
watch(
  () => props.word?.id,
  (id, before) => {
    if (!id || id === before) return;
    expandedContexts.value = false;
    if (!before)
      tab.value =
        props.word.encounters?.length && tabs.value.some((item) => item.id === "context")
          ? "context"
          : "meaning";
  },
);
function edit() {
  tab.value = "records";
  editing.value = true;
}
</script>
<template>
  <article
    v-if="word"
    class="d-word-card"
    aria-label="词条详情"
    data-guide="word-card"
    :data-guide-state="word.deletedAt ? 'deleted' : word.manualActive ? 'manual' : 'public'"
  >
    <header class="reader-heading">
      <p class="eyebrow">{{ word.manualActive ? "我的单词" : "公共词典" }}</p>
      <h2>{{ word.word }}</h2>
    </header>
    <section
      v-if="has('pronunciation')"
      class="word-pronunciation"
      data-card-module="pronunciation"
    >
      <p>
        {{ phonetics.join(" · ") || entry?.ecdict?.legacy_phonetic || word.phonetic }}
      </p>
      <div class="row" data-guide="word-audio">
        <button class="text-button" @click="emit('speak', word.word, 'us')">
          <Icon name="volume" />美式</button
        ><button class="text-button" @click="emit('speak', word.word, 'uk')">
          <Icon name="volume" />英式</button
        ><small v-if="audio?.word === word.word" aria-live="polite">{{
          {
            loading: "加载…",
            playing: "播放中",
            completing: "播放结束",
            failed: "发音不可用",
          }[audio.state]
        }}</small>
      </div>
    </section>
    <section data-card-module="meaning" class="word-overview">
      <p class="word-summary">{{ summary }}</p>
    </section>
    <div v-if="has('collections') && word.books?.length" class="word-classifications">
      {{ word.books.map((item) => item.name).join(" · ") }}
    </div>
    <div class="reader-tabs" role="tablist" aria-label="词条阅读内容">
      <button
        v-for="item in tabs"
        :key="item.id"
        role="tab"
        :aria-selected="tab === item.id"
        :class="{ active: tab === item.id }"
        @click="tab = item.id"
      >
        {{ item.name
        }}<small v-if="item.id === 'context' && word.encounters?.length">{{
          word.encounters.length
        }}</small></button
      ><button
        v-if="!word.deletedAt && (has('note') || has('collections'))"
        class="icon-button reader-edit"
        aria-label="编辑笔记与归类"
        title="编辑笔记与归类"
        @click="edit"
      >
        <Icon name="pencil" /><i v-if="dirty" class="draft-dot" />
      </button>
    </div>
    <div class="reader-content">
      <section v-show="tab === 'context'" role="tabpanel" aria-label="语境" class="context-reading">
        <template v-if="word.encounters?.length"
          ><article v-for="item in contexts" :key="item.id" class="context-entry">
            <p class="context-source">
              {{ item.sourceTitle || "我的遇见"
              }}<time>{{ new Date(item.createdAt).toLocaleDateString() }}</time>
            </p>
            <blockquote>
              <ContextText :text="item.context" :word="word.word" /> </blockquote></article
        ></template>
        <template v-else
          ><p class="muted">还没有这个词的遇见记录。</p>
          <article v-if="senses[0]?.examples?.[0]" class="context-entry">
            <p class="context-source">词典例句</p>
            <blockquote>{{ senses[0].examples[0].text }}</blockquote>
            <p class="muted">{{ senses[0].examples[0].translation }}</p>
          </article></template
        >
        <button
          v-if="word.encounters?.length > 1 && !has('encounterList')"
          class="text-button"
          @click="expandedContexts = !expandedContexts"
        >
          {{ expandedContexts ? "只看最近语境" : `查看全部 ${word.encounters.length} 条遇见` }}
        </button>
      </section>
      <WordMeaning v-show="tab === 'meaning'" :word="word" :sections="sections" />
      <section v-show="tab === 'records'" role="tabpanel" aria-label="记录" class="record-reading">
        <template v-for="section in sections" :key="section">
          <section v-if="section === 'note'" class="reading-section" data-card-module="note">
            <div class="section-heading">
              <h3>我的笔记</h3>
              <button v-if="!editing && !word.deletedAt" class="text-button" @click="edit">
                {{ word.note ? "编辑" : "添加笔记" }}
              </button>
            </div>
            <textarea
              v-if="editing && !word.deletedAt"
              v-model="note"
              aria-label="我的笔记"
              placeholder="记下自己的理解…"
              maxlength="20000"
            />
            <p v-else class="preserve-lines muted">
              {{ word.note || "还没有笔记" }}
            </p>
          </section>
          <section
            v-if="section === 'collections'"
            class="reading-section"
            data-card-module="collections"
          >
            <h3>单词本</h3>
            <template v-if="editing && !word.deletedAt"
              ><fieldset class="relation-options">
                <legend>单词本</legend>
                <label
                  v-for="book in state.books.filter((item) => !item.role)"
                  :key="book.id"
                  class="inline-check"
                  ><input
                    type="checkbox"
                    v-model="selectedBooks"
                    :value="book.id"
                    :aria-label="`关联单词本 ${book.name}`"
                  />{{ book.name }}</label
                >
                <p v-if="!state.books.some((item) => !item.role)" class="muted">
                  可从侧边栏创建单词本。
                </p>
              </fieldset></template
            >
            <p v-else class="muted">
              {{ (word.books || []).map((item) => item.name).join(" · ") || "未加入单词本" }}
            </p>
          </section>
          <section
            v-if="section === 'reviewSummary'"
            class="reading-section"
            data-card-module="reviewSummary"
          >
            <h3>学习概览</h3>
            <p> {{ word.reviewCount || 0 }} 次反馈 · {{ word.encounters?.length || 0 }} 次遇见 </p>
            <p v-if="word.lastReviewedAt" class="muted">
              最近学习 {{ new Date(word.lastReviewedAt).toLocaleString() }}
            </p>
            <p v-if="word.dueAt" class="muted">
              下次复习 {{ new Date(word.dueAt).toLocaleString() }}
            </p>
          </section>
        </template>
        <div v-if="editing && !word.deletedAt" class="reader-save">
          <p v-if="conflict" class="error-banner">
            资料已更新，草稿保留。请先复制草稿，再载入当前版本。
          </p>
          <button v-if="conflict" class="text-button" @click="reset(word)"> 载入当前版本 </button>
          <div class="row">
            <button class="button primary" :disabled="busy || conflict" @click="save">
              保存笔记与归类</button
            ><button class="text-button" @click="editing = false"> 收起编辑</button
            ><small v-if="dirty" class="muted">草稿未保存</small>
          </div>
        </div>
      </section>
    </div>
    <footer class="word-personal-actions" v-if="!word.deletedAt">
      <span class="muted">{{ word.encounters?.length || 0 }} 次遇见</span
      ><button
        class="button small"
        v-if="!word.manualActive"
        data-guide="word-collect"
        :disabled="busy"
        @click="emit('command', { action: 'collect', wordId: word.id })"
      >
        <Icon name="bookmark" />加入手动收藏
      </button>
      <button
        class="button small danger"
        data-guide="word-trash"
        :disabled="busy"
        @click="emit('request-trash', word)"
      >
        <Icon name="trash" />移到回收站
      </button>
    </footer>
  </article>
  <div class="empty" v-else>
    <Icon name="book-2" />
    <p>选择一个词，开始阅读。</p>
  </div>
</template>
