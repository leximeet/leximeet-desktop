<script setup>
import { computed, ref, watch } from "vue";
import ReadableText from "./ReadableText.vue";
const props = defineProps({ word: Object, sections: Array });
const expanded = ref(false);
const entry = computed(() => props.word?.entry);
const senses = computed(() => entry.value?.senses || []);
const has = (section) => props.sections.includes(section);
watch(
  () => props.word?.id,
  () => {
    expanded.value = false;
  },
);
</script>
<template>
  <section role="tabpanel" aria-label="释义" class="meaning-reading">
    <ReadableText class="meaning-intro" :text="entry?.headword_summary_zh || word.meaning || ''" />
    <template v-if="has('evidence')"
      ><article
        v-for="sense in expanded ? senses : senses.slice(0, 2)"
        :key="sense.sense_id"
        class="sense-entry"
      >
        <h3>
          <em>{{ sense.pos }}</em
          >{{ sense.short_gloss }}
        </h3>
        <ReadableText v-if="sense.learner_explanation_zh" :text="sense.learner_explanation_zh" />
        <blockquote
          v-for="example in (sense.examples || []).slice(0, expanded ? 5 : 1)"
          :key="example.text"
        >
          <p>{{ example.text }}</p>
          <small>{{ example.translation }}</small>
        </blockquote>
        <ReadableText
          v-if="expanded && sense.usage_note_zh"
          class="muted"
          :text="sense.usage_note_zh"
        />
        <p v-if="expanded && sense.english_gloss" class="muted">
          {{ sense.english_gloss }}
        </p>
      </article>
      <button v-if="senses.length" class="text-button" @click="expanded = !expanded">
        {{ expanded ? "收起完整词条" : `展开完整词条 · ${senses.length} 个词义` }}
      </button>
      <section v-if="expanded" class="extra-evidence">
        <h3 v-if="entry?.forms?.length">词形变化</h3>
        <p v-if="entry?.forms?.length">
          {{
            entry.forms
              .map((form) => form.text + (form.tags?.length ? ` (${form.tags.join(", ")})` : ""))
              .join(" · ")
          }}
        </p>
        <h3 v-if="entry?.learning?.mnemonics?.length">记忆提示</h3>
        <ReadableText
          v-for="item in entry?.learning?.mnemonics || []"
          :key="item.content"
          :text="item.content" />
        <small v-if="entry?.learning?.mnemonics?.length" class="muted"
          >来源材料，含 AI 辅助内容</small
        >
        <ReadableText
          v-for="text in entry?.study_notes_zh || []"
          :key="text"
          :text="text" /></section
    ></template>
    <details class="source-details">
      <summary>来源与数据</summary>
      <p v-if="entry">
        leximeet-dictionary 0.0.3 · {{ entry.origin }} ·
        {{ entry.audit_status }}
      </p>
      <p class="muted break-word">
        {{ entry?.entry_id || "手动词条，尚未关联公共词典" }}
      </p>
      <p
        v-for="source in [
          ...new Set(senses.map((sense) => sense.source_ref?.source).filter(Boolean)),
        ]"
        :key="source"
      >
        {{ source }}
      </p>
    </details>
  </section>
</template>
