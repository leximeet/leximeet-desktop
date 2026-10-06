import { ref, watch, computed } from "vue";

// 每个词条保存独立草稿；后台刷新只更新已确认版本，绝不静默覆盖用户编辑。
export function useWordDraft(getWord, submit) {
  const note = ref(""),
    selectedBooks = ref([]),
    baseRevision = ref(0),
    conflict = ref(false);
  const drafts = new Map();
  const baseline = ref("");
  let loadedId = "",
    pendingSave;
  const packed = () => JSON.stringify([note.value, [...selectedBooks.value].sort()]);
  const fromWord = (word) =>
    JSON.stringify([word?.note || "", (word?.books || []).map((item) => item.id).sort()]);
  function reset(word) {
    note.value = word?.note || "";
    selectedBooks.value = (word?.books || []).map((item) => item.id);
    baseline.value = packed();
    baseRevision.value = word?.revision || 0;
    conflict.value = false;
    pendingSave = null;
  }
  // 刷新音频、任务或主题不能覆盖未保存草稿；保存回执只更新对应版本。
  watch(
    getWord,
    (word) => {
      if (!word) return;
      if (loadedId !== word.id) {
        if (loadedId)
          drafts.set(loadedId, {
            note: note.value,
            books: [...selectedBooks.value],
            baseline: baseline.value,
            revision: baseRevision.value,
          });
        loadedId = word.id;
        reset(word);
        const cached = drafts.get(word.id);
        if (cached && cached.baseline !== JSON.stringify([cached.note, [...cached.books].sort()])) {
          note.value = cached.note;
          selectedBooks.value = cached.books;
          baseline.value = cached.baseline;
          baseRevision.value = cached.revision;
          conflict.value = cached.revision !== word.revision;
        }
        return;
      }
      const incoming = fromWord(word);
      if (packed() === baseline.value || incoming === packed()) reset(word);
      else if (pendingSave === incoming) {
        baseline.value = incoming;
        baseRevision.value = word.revision;
        pendingSave = null;
        conflict.value = false;
      } else if (word.revision !== baseRevision.value) conflict.value = true;
    },
    { immediate: true },
  );
  function save() {
    const word = getWord();
    if (!word || word.id !== loadedId) return false;
    pendingSave = packed();
    // 仅提交本界面编辑的字段。冻结的标签、个人释义等字段留在 Core，不能随笔记保存清空。
    submit({
      action: "saveNote",
      wordId: word.id,
      note: note.value,
      bookIds: [...selectedBooks.value],
      expectedRevision: baseRevision.value,
    });
    return true;
  }

  return {
    note,
    selectedBooks,
    conflict,
    save,
    reset,
    dirty: computed(() => packed() !== baseline.value),
  };
}
