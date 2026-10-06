/**
 * 本机工作区的写操作串行执行，读快照与写回执使用同一队列。
 * 不再因为另一个按钮正在保存就静默丢弃操作，也不会被先发后到的刷新覆盖。
 * 各页面的草稿仍由页面持有；这里仅管理 Core 已确认的事实。
 */
export function createWorkspaceController({ api, publish }) {
  let tail = Promise.resolve(),
    pending = 0,
    disposed = false,
    refreshing,
    publishedGuide;
  const unconfirmedFeedback = new Set();
  const guideCommands = new Set([
    "guideStart",
    "guidePause",
    "guideResume",
    "guideReset",
    "guidePrevious",
    "guideNext",
  ]);
  const emit = (patch) => {
    if (disposed) return;
    if (patch.state) {
      let state = patch.state;
      // Core 事实继续刷新，但原反馈草稿未确认时，任何刷新都不能提前推动教学切页。
      if (unconfirmedFeedback.size && publishedGuide !== undefined)
        state = {
          ...state,
          guide: JSON.parse(JSON.stringify(publishedGuide)),
        };
      else if (state.guide !== undefined) publishedGuide = JSON.parse(JSON.stringify(state.guide));
      publish({ ...patch, state });
    } else publish(patch);
  };
  function enqueue(work, mutation = false) {
    if (disposed) return Promise.resolve(false);
    if (mutation) {
      pending++;
      emit({ busy: true });
    }
    const result = tail.then(async () => {
      try {
        emit({ error: "" });
        return await work();
      } catch (failure) {
        emit({ error: failure.message });
        return false;
      } finally {
        if (mutation) {
          pending--;
          emit({ busy: pending > 0 });
        }
      }
    });
    tail = result.catch(() => {});
    return result;
  }
  async function snapshot() {
    const state = await api.desktopState();
    emit({ state });
    return state;
  }
  return {
    refresh() {
      if (refreshing) return refreshing;
      refreshing = enqueue(async () => {
        try {
          const [state, runtime] = await Promise.all([api.desktopState(), api.runtime()]);
          emit({ state, runtime });
          return true;
        } finally {
          emit({ loading: false });
        }
      }).finally(() => {
        refreshing = null;
      });
      return refreshing;
    },
    command(payload, message = "") {
      return enqueue(async () => {
        const state = await api.desktopCommand(payload);
        // 明确跳过、重开或移动教学是用户选择；只解除 UI 持有，不撤销已有练习事实。
        if (guideCommands.has(payload.action)) unconfirmedFeedback.clear();
        emit({ state, notice: message });
        return true;
      }, true);
    },
    practiceFeedback(payload, onConfirmed = async () => {}) {
      return enqueue(async () => {
        // 请求结果未确认和确认草稿失败都沿用原 ID；另一词的成功反馈不能解除这项持有。
        unconfirmedFeedback.add(payload.submissionId);
        const state = await api.desktopCommand(payload);
        const feedback = state.practiceFeedback;
        // 只有同一提交的核心回执才能解锁答题；缺失回执不能猜测为成功。
        if (
          feedback?.submissionId !== payload.submissionId ||
          typeof feedback.correct !== "boolean" ||
          typeof feedback.effective !== "boolean"
        )
          throw new Error("练习回执不完整，请重试当前答案");
        // 教学进度发布会立即切页。先把原页面的已确认回执落盘，避免卸载保存 pending 草稿。
        await onConfirmed(feedback);
        unconfirmedFeedback.delete(payload.submissionId);
        emit({ state });
        return feedback;
      }, true);
    },
    settings(patch) {
      return enqueue(async () => {
        await api.settings(patch);
        await snapshot();
        return true;
      }, true);
    },
    native(action) {
      return enqueue(async () => {
        const result = await api.desktopAction({ action });
        if (!result.cancelled) {
          await snapshot();
          emit({ notice: result.message || "操作已完成" });
        }
        return result;
      }, true);
    },
    dispose() {
      disposed = true;
    },
  };
}
