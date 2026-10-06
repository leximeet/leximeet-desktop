/**
 * 列表与详情共用一个查询边界。只把当前结果里的词交给阅读器，
 * 新搜索、切页或离开页面会使旧详情失效；网络失败也要校验请求代次。
 * 不依赖 Vue，便于用延迟响应测试真实竞态。
 */
export function createLibraryState() {
  return {
    words: [],
    selected: null,
    selectedId: "",
    total: 0,
    offset: 0,
    loading: false,
    detailLoading: false,
    error: "",
    checkedIds: [],
  };
}

// 批量操作只面向当前页。翻页或筛选不留下看不见的勾选，后台刷新则保留仍存在的词。
export function createLibrarySelection(state) {
  const pageIds = () => [...new Set(state.words.map((word) => word.id))];
  function reconcile() {
    const available = new Set(pageIds());
    state.checkedIds = [...new Set(state.checkedIds)].filter((id) => available.has(id));
  }
  return {
    reconcile,
    clear() {
      state.checkedIds = [];
    },
    toggle(id, checked) {
      if (!pageIds().includes(id)) return;
      const selected = new Set(state.checkedIds);
      if (checked) selected.add(id);
      else selected.delete(id);
      state.checkedIds = [...selected];
    },
    setPage(checked) {
      state.checkedIds = checked ? pageIds() : [];
    },
    ids() {
      reconcile();
      return [...state.checkedIds];
    },
  };
}

export function createLibraryQuery({ state, query, pageSize = 40 }) {
  const selection = createLibrarySelection(state);
  let listVersion = 0,
    detailVersion = 0,
    active = true;
  function invalidate({ clear = false } = {}) {
    listVersion++;
    detailVersion++;
    state.loading = false;
    state.detailLoading = false;
    selection.clear();
    if (clear) {
      state.words = [];
      state.selected = null;
      state.selectedId = "";
      state.total = 0;
    }
  }
  async function select(id) {
    if (!active || !state.words.some((word) => word.id === id)) return false;
    const ticket = ++detailVersion,
      listTicket = listVersion;
    state.selectedId = id;
    if (state.selected?.id !== id) state.selected = null;
    state.detailLoading = true;
    state.error = "";
    const current = () => active && ticket === detailVersion && listTicket === listVersion;
    try {
      const detail = await query({ kind: "detail", wordId: id });
      if (!current()) return false;
      state.selected = detail;
      return true;
    } catch (failure) {
      if (current()) {
        state.selected = null;
        state.error = failure.message;
      }
      return false;
    } finally {
      if (current()) state.detailLoading = false;
    }
  }
  async function load(filter, offset = state.offset) {
    if (!active) return false;
    const previousId = state.selectedId;
    const ticket = ++listVersion;
    ++detailVersion;
    state.loading = true;
    state.detailLoading = false;
    state.error = "";
    const current = () => active && ticket === listVersion;
    try {
      const result = await query({ ...filter, offset, limit: pageSize });
      if (!current()) return false;
      // 删除最后一页的最后一词后回到仍存在的一页，而不是留下空页。
      if (offset && offset >= result.total) {
        return await load(
          filter,
          Math.max(0, Math.floor((result.total - 1) / pageSize) * pageSize),
        );
      }
      state.words = result.words;
      selection.reconcile();
      state.total = result.total;
      state.offset = offset;
      const id = result.words.some((word) => word.id === previousId)
        ? previousId
        : result.words[0]?.id;
      if (id) await select(id);
      else {
        state.selectedId = "";
        state.selected = null;
      }
      return current();
    } catch (failure) {
      if (current()) state.error = failure.message;
      return false;
    } finally {
      if (current()) state.loading = false;
    }
  }
  return {
    load,
    select,
    invalidate,
    activate() {
      active = true;
    },
    deactivate() {
      active = false;
      invalidate();
    },
  };
}
