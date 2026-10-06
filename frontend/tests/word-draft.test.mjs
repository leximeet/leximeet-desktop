import test from "node:test";
import assert from "node:assert/strict";
import { effectScope, ref, nextTick } from "vue";
import { useWordDraft } from "../src/desktop/useWordDraft.js";

test("保存回执消除未保存标记；清空搜索后回来仍有草稿；异词与版本冲突互不覆盖", async () => {
  const scope = effectScope(),
    word = ref({ id: "a", revision: 1, note: "原文", books: [] }),
    calls = [];
  const draft = scope.run(() =>
    useWordDraft(
      () => word.value,
      (value) => calls.push(value),
    ),
  );
  draft.note.value = "我的草稿";
  assert.equal(draft.dirty.value, true);
  word.value = null;
  await nextTick();
  word.value = { id: "a", revision: 1, note: "原文", books: [] };
  await nextTick();
  assert.equal(draft.note.value, "我的草稿");
  draft.save();
  assert.equal(calls[0].expectedRevision, 1);
  word.value = { ...word.value, revision: 2, note: "我的草稿" };
  await nextTick();
  assert.equal(draft.dirty.value, false);
  draft.note.value = "第二版草稿";
  word.value = { id: "b", revision: 1, note: "别的词", books: [] };
  await nextTick();
  assert.equal(draft.note.value, "别的词");
  word.value = { id: "a", revision: 3, note: "外部更新", books: [] };
  await nextTick();
  assert.equal(draft.note.value, "第二版草稿");
  assert.equal(draft.conflict.value, true);
  draft.reset(word.value);
  assert.equal(draft.note.value, "外部更新");
  assert.equal(draft.dirty.value, false);
  scope.stop();
});

test("个人编辑只提交笔记与多选词本，公共释义不进入编辑命令", async () => {
  const scope = effectScope(),
    word = ref({
      id: "a",
      revision: 7,
      note: "原笔记",
      meaning: "公共词典释义",
      books: [{ id: "one", name: "词本一" }],
    }),
    calls = [];
  const draft = scope.run(() =>
    useWordDraft(
      () => word.value,
      (payload) => calls.push(payload),
    ),
  );
  draft.note.value = "更新笔记";
  draft.selectedBooks.value = ["one", "two"];
  draft.save();
  assert.deepEqual(calls[0], {
    action: "saveNote",
    wordId: "a",
    note: "更新笔记",
    bookIds: ["one", "two"],
    expectedRevision: 7,
  });
  assert.equal(Object.hasOwn(calls[0], "tagIds"), false);
  assert.equal(Object.hasOwn(calls[0], "meaning"), false);
  word.value = {
    ...word.value,
    revision: 8,
    note: "更新笔记",
    books: [{ id: "one" }, { id: "two" }],
  };
  await nextTick();
  assert.equal(draft.dirty.value, false);
  assert.equal(word.value.meaning, "公共词典释义");
  // 词本关联也属于同一份草稿，跨词切换后原样保留。
  draft.selectedBooks.value = ["two"];
  word.value = { id: "b", revision: 1, note: "", books: [] };
  await nextTick();
  word.value = { id: "a", revision: 8, note: "更新笔记", books: [{ id: "one" }, { id: "two" }] };
  await nextTick();
  assert.deepEqual(draft.selectedBooks.value, ["two"]);
  assert.equal(draft.dirty.value, true);
  scope.stop();
});

test("外部词本更新触发整体版本冲突，空详情不能发送保存", async () => {
  const scope = effectScope(),
    word = ref({ id: "a", revision: 1, note: "原笔记", books: [{ id: "one" }] }),
    calls = [];
  const draft = scope.run(() =>
    useWordDraft(
      () => word.value,
      (payload) => calls.push(payload),
    ),
  );
  draft.note.value = "未保存的草稿";
  word.value = { ...word.value, revision: 2, books: [{ id: "two" }] };
  await nextTick();
  assert.equal(draft.conflict.value, true);
  assert.equal(draft.note.value, "未保存的草稿");
  word.value = null;
  await nextTick();
  assert.equal(draft.save(), false);
  assert.equal(calls.length, 0);
  scope.stop();
});
