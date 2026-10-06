import test from "node:test";
import assert from "node:assert/strict";
import {
  createLibraryQuery,
  createLibraryState,
  createLibrarySelection,
} from "../src/desktop/library-query.js";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const word = (id) => ({ id, word: id });

test("空搜索清除旧词；翻页只能选择新结果里的词", async () => {
  const state = createLibraryState();
  const controller = createLibraryQuery({
    state,
    query: async (q) =>
      q.kind === "detail"
        ? word(q.wordId)
        : {
            total: q.search ? 0 : 2,
            words: q.search ? [] : [word(q.offset ? "b" : "a")],
          },
  });
  await controller.load({});
  assert.equal(state.selected.id, "a");
  await controller.load({}, 1);
  assert.equal(state.selected.id, "b");
  await controller.load({ search: "missing" }, 0);
  assert.equal(state.selected, null);
  assert.equal(state.selectedId, "");
});

test("旧详情返回和旧搜索失败都不能污染新搜索", async () => {
  const pending = deferred(),
    stale = deferred();
  const state = createLibraryState();
  const controller = createLibraryQuery({
    state,
    query: (q) =>
      q.kind === "detail"
        ? pending.promise
        : q.search === "old"
          ? stale.promise
          : Promise.resolve({
              total: q.search ? 0 : 1,
              words: q.search ? [] : [word("a")],
            }),
  });
  const old = controller.load({});
  await Promise.resolve();
  const oldSearch = controller.load({ search: "old" });
  await controller.load({ search: "new" });
  pending.resolve(word("a"));
  stale.reject(new Error("old failure"));
  await Promise.all([old, oldSearch]);
  assert.equal(state.selected, null);
  assert.equal(state.error, "");
  assert.equal(state.loading, false);
});

test("快速选择保留最后一次意图，离开页面使详情失效", async () => {
  const a = deferred(),
    b = deferred();
  const state = { ...createLibraryState(), words: [word("a"), word("b")] };
  const controller = createLibraryQuery({
    state,
    query: (q) => (q.wordId === "a" ? a.promise : b.promise),
  });
  const first = controller.select("a"),
    second = controller.select("b");
  b.resolve(word("b"));
  await second;
  a.resolve(word("a"));
  await first;
  assert.equal(state.selected.id, "b");
  const later = controller.select("a");
  controller.deactivate();
  await later;
  assert.equal(state.selected, null);
  assert.equal(state.detailLoading, false);
});

test("删空最后一页时退回上一页，详情失败可重试且不展示旧词", async () => {
  const offsets = [];
  let fail = true;
  const state = createLibraryState();
  const controller = createLibraryQuery({
    state,
    query: async (q) => {
      if (q.kind === "detail") {
        if (fail) throw new Error("离线");
        return word("a");
      }
      offsets.push(q.offset);
      return { total: 1, words: q.offset ? [] : [word("a")] };
    },
  });
  await controller.load({}, 40);
  assert.deepEqual(offsets, [40, 0]);
  assert.equal(state.selected, null);
  assert.equal(state.error, "离线");
  fail = false;
  await controller.select("a");
  assert.equal(state.selected.id, "a");
  assert.equal(state.error, "");
});

test("切换状态携带搜索条件，迟到的旧状态结果不能覆盖新筛选", async () => {
  const stale = deferred(),
    requests = [],
    state = createLibraryState();
  const controller = createLibraryQuery({
    state,
    query: async (request) => {
      requests.push(request);
      if (request.kind === "detail") return word(request.wordId);
      if (request.learningStatus === "learning") return stale.promise;
      return { total: 1, words: [word("review-word")] };
    },
  });
  const old = controller.load(
    {
      scope: "book",
      bookId: "book-a",
      search: "word",
      learningStatus: "learning",
    },
    40,
  );
  controller.invalidate({ clear: true });
  await controller.load(
    {
      scope: "book",
      bookId: "book-a",
      search: "word",
      learningStatus: "review",
    },
    0,
  );
  stale.resolve({ total: 80, words: [word("old-word")] });
  await old;
  assert.equal(state.selectedId, "review-word");
  assert.equal(state.total, 1);
  assert.equal(state.offset, 0);
  assert.deepEqual(requests[1], {
    scope: "book",
    bookId: "book-a",
    search: "word",
    learningStatus: "review",
    offset: 0,
    limit: 40,
  });
});

test("当前页多选去重、全选和取消，不能批量操作不在当前页的词", () => {
  const state = { ...createLibraryState(), words: [word("a"), word("b")] };
  const selection = createLibrarySelection(state);
  selection.toggle("a", true);
  selection.toggle("a", true);
  selection.toggle("hidden", true);
  assert.deepEqual(selection.ids(), ["a"]);
  selection.setPage(true);
  assert.deepEqual(selection.ids(), ["a", "b"]);
  selection.toggle("a", false);
  assert.deepEqual(selection.ids(), ["b"]);
  selection.setPage(false);
  assert.deepEqual(selection.ids(), []);
});

test("刷新保留有效勾选，回收词从选择中移除；新筛选与离开页面清空选择", async () => {
  let available = [word("a"), word("b")];
  const state = createLibraryState(),
    selection = createLibrarySelection(state),
    controller = createLibraryQuery({
      state,
      query: async (request) =>
        request.kind === "detail"
          ? word(request.wordId)
          : { total: available.length, words: available },
    });
  await controller.load({ sort: "recent", partOfSpeech: "noun" });
  selection.setPage(true);
  available = [word("b")];
  await controller.load({ sort: "recent", partOfSpeech: "noun" });
  assert.deepEqual(selection.ids(), ["b"]);
  controller.invalidate({ clear: true });
  assert.deepEqual(state.checkedIds, []);
  assert.equal(state.words.length, 0);
  await controller.load({ sort: "alphabetical", partOfSpeech: "all" });
  selection.setPage(true);
  controller.deactivate();
  assert.deepEqual(state.checkedIds, []);
});

test("词性和排序属于同一查询意图，迟到结果不能带回旧词与旧选择", async () => {
  const stale = deferred(),
    state = createLibraryState(),
    selection = createLibrarySelection(state),
    requests = [];
  const controller = createLibraryQuery({
    state,
    query: async (request) => {
      requests.push(request);
      if (request.kind === "detail") return word(request.wordId);
      if (request.partOfSpeech === "noun") return stale.promise;
      return { total: 1, words: [word("run")] };
    },
  });
  const old = controller.load({ scope: "library", partOfSpeech: "noun", sort: "recent" });
  controller.invalidate({ clear: true });
  await controller.load({ scope: "library", partOfSpeech: "verb", sort: "alphabetical" });
  selection.toggle("run", true);
  stale.resolve({ total: 1, words: [word("desk")] });
  await old;
  assert.equal(state.selectedId, "run");
  assert.deepEqual(selection.ids(), ["run"]);
  assert.equal(requests[1].sort, "alphabetical");
  assert.equal(requests[1].partOfSpeech, "verb");
});
