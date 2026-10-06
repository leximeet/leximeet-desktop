import test from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceController } from "../src/desktop/workspace-controller.js";

test("教学状态发布之前等待页面把同一回执保存，切页不会覆盖确认草稿", async () => {
  const order = [];
  const payload = { action: "practiceRecord", submissionId: "lesson" };
  const controller = createWorkspaceController({
    api: {
      desktopCommand: async () => ({
        practiceFeedback: {
          submissionId: "lesson",
          correct: true,
          effective: true,
        },
      }),
    },
    publish: (patch) => {
      if (patch.state) order.push("publish");
    },
  });
  await controller.practiceFeedback(payload, async () => {
    order.push("clear-pending");
    await Promise.resolve();
    order.push("persist-confirmed");
  });
  assert.deepEqual(order, ["clear-pending", "persist-confirmed", "publish"]);
  controller.dispose();
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test("刷新中的连续命令不会丢弃，旧快照不会覆盖新回执", async () => {
  const gate = deferred(),
    view = {},
    calls = [];
  const controller = createWorkspaceController({
    publish: (patch) => Object.assign(view, patch),
    api: {
      desktopState: () => gate.promise,
      runtime: async () => ({}),
      desktopCommand: async ({ id }) => {
        calls.push(id);
        return { version: id };
      },
    },
  });
  const refresh = controller.refresh();
  const first = controller.command({ id: 1 }),
    second = controller.command({ id: 2 });
  assert.equal(view.busy, true);
  gate.resolve({ version: 0 });
  assert.deepEqual(await Promise.all([refresh, first, second]), [true, true, true]);
  assert.deepEqual(calls, [1, 2]);
  assert.equal(view.state.version, 2);
  assert.equal(view.busy, false);
});
test("失败不会阻塞下一次操作；离开后不再向已卸载页面发布", async () => {
  const view = {};
  const controller = createWorkspaceController({
    publish: (patch) => Object.assign(view, patch),
    api: {
      desktopCommand: async ({ fail }) => {
        if (fail) throw new Error("保存失败");
        return { ok: true };
      },
    },
  });
  assert.equal(await controller.command({ fail: true }), false);
  assert.equal(view.error, "保存失败");
  assert.equal(await controller.command({}), true);
  assert.equal(view.error, "");
  controller.dispose();
  assert.equal(await controller.command({}), false);
  assert.equal(view.busy, false);
});

test("练习回执与提交绑定，不使用命令成功布尔值推断正误", async () => {
  const view = {};
  let wrong = false;
  const controller = createWorkspaceController({
    publish: (patch) => Object.assign(view, patch),
    api: {
      desktopCommand: async (q) => ({
        practiceFeedback: {
          submissionId: wrong ? "wrong" : q.submissionId,
          correct: false,
          effective: true,
          delta: -1,
        },
      }),
    },
  });
  const payload = { action: "practiceRecord", submissionId: "request-1" };
  assert.equal((await controller.practiceFeedback(payload)).correct, false);
  wrong = true;
  assert.equal(await controller.practiceFeedback(payload), false);
  assert.match(view.error, /回执不完整/);
});

// 有界 API 适配器保留同 ID 回执；controller 与所有状态发布路径使用生产实现。
function guideFixture() {
  const view = {},
    facts = new Map(),
    coreState = {
      guide: { active: true, cursor: 5, completed: [] },
      practiceCount: 0,
      noteCount: 0,
      encounterCount: 0,
      settings: { theme: "light" },
    };
  let failFeedbackOnce = false,
    malformedFeedbackOnce = false;
  const api = {
    desktopState: async () => structuredClone(coreState),
    runtime: async () => ({ connected: true }),
    desktopCommand: async (q) => {
      if (q.action === "practiceRecord") {
        if (!facts.has(q.submissionId)) {
          coreState.practiceCount++;
          coreState.guide.cursor++;
          facts.set(q.submissionId, {
            submissionId: q.submissionId,
            correct: true,
            effective: true,
          });
        }
        if (failFeedbackOnce) {
          failFeedbackOnce = false;
          throw new Error("真实提交结果未确认");
        }
        const feedback = structuredClone(facts.get(q.submissionId));
        if (malformedFeedbackOnce) {
          malformedFeedbackOnce = false;
          feedback.submissionId = "wrong-submission";
        }
        return {
          ...structuredClone(coreState),
          practiceFeedback: feedback,
        };
      }
      if (q.fail) throw new Error("教学命令失败");
      if (q.action.startsWith("guide")) coreState.guide.active = false;
      else coreState.noteCount++;
      return structuredClone(coreState);
    },
    settings: async (patch) => Object.assign(coreState.settings, patch),
    desktopAction: async () => {
      coreState.encounterCount++;
      return { cancelled: false };
    },
  };
  return {
    view,
    coreState,
    facts,
    failNextFeedback: () => (failFeedbackOnce = true),
    failNextReceipt: () => (malformedFeedbackOnce = true),
    controller: createWorkspaceController({
      api,
      publish: (patch) => Object.assign(view, patch),
    }),
  };
}

test("确认草稿失败后所有刷新保留当前教学，事实继续更新，原反馈恢复才前进", async () => {
  const f = guideFixture();
  await f.controller.refresh();
  const originalGuide = structuredClone(f.view.state.guide),
    request = { action: "practiceRecord", submissionId: "copy-original" };
  assert.equal(
    await f.controller.practiceFeedback(request, async () => {
      throw new Error("确认草稿保存失败");
    }),
    false,
  );
  await f.controller.refresh();
  assert.deepEqual(f.view.state.guide, originalGuide);
  assert.equal(f.view.state.practiceCount, 1);
  assert.equal(f.view.runtime.connected, true);
  await f.controller.command({ action: "saveNote" });
  assert.deepEqual(f.view.state.guide, originalGuide);
  assert.equal(f.view.state.noteCount, 1);
  await f.controller.settings({ theme: "dark" });
  assert.deepEqual(f.view.state.guide, originalGuide);
  assert.equal(f.view.state.settings.theme, "dark");
  await f.controller.native("capture");
  assert.deepEqual(f.view.state.guide, originalGuide);
  assert.equal(f.view.state.encounterCount, 1);
  await f.controller.practiceFeedback(request);
  assert.deepEqual(f.view.state.guide, f.coreState.guide);
  assert.equal(f.view.state.guide.cursor, originalGuide.cursor + 1);
  assert.equal(f.facts.size, 1);
  f.controller.dispose();
});

test("请求 ACK 未确认或回执不完整也持有教学，定时刷新不能绕过原事件恢复", async () => {
  for (const failure of ["failNextFeedback", "failNextReceipt"]) {
    const f = guideFixture();
    await f.controller.refresh();
    const originalGuide = structuredClone(f.view.state.guide),
      request = { action: "practiceRecord", submissionId: "unknown-original" };
    f[failure]();
    assert.equal(await f.controller.practiceFeedback(request), false);
    await f.controller.refresh();
    assert.deepEqual(f.view.state.guide, originalGuide);
    assert.equal(f.view.state.practiceCount, 1);
    await f.controller.practiceFeedback(request);
    assert.equal(f.view.state.guide.cursor, originalGuide.cursor + 1);
    assert.equal(f.facts.size, 1);
    f.controller.dispose();
  }
});

test("多个列表反馈分别持有教学，只恢复其中一个不能解除其他未决提交", async () => {
  const f = guideFixture();
  await f.controller.refresh();
  const originalGuide = structuredClone(f.view.state.guide),
    failConfirmation = async () => {
      throw new Error("草稿未确认");
    },
    first = { action: "practiceRecord", submissionId: "list-first" },
    second = { action: "practiceRecord", submissionId: "list-second" };
  await f.controller.practiceFeedback(first, failConfirmation);
  await f.controller.practiceFeedback(second, failConfirmation);
  await f.controller.practiceFeedback(second);
  assert.deepEqual(f.view.state.guide, originalGuide);
  assert.equal(f.view.state.practiceCount, 2);
  await f.controller.refresh();
  assert.deepEqual(f.view.state.guide, originalGuide);
  await f.controller.practiceFeedback(first);
  assert.deepEqual(f.view.state.guide, f.coreState.guide);
  assert.equal(f.facts.size, 2);
  f.controller.dispose();
});

test("用户明确跳过或移动教学解除 UI 持有，失败命令不解除，也不撤销练习事实", async () => {
  for (const action of [
    "guideStart",
    "guidePause",
    "guideResume",
    "guideReset",
    "guidePrevious",
    "guideNext",
  ]) {
    const f = guideFixture();
    await f.controller.refresh();
    const originalGuide = structuredClone(f.view.state.guide);
    await f.controller.practiceFeedback(
      { action: "practiceRecord", submissionId: "pending-" + action },
      async () => {
        throw new Error("确认草稿失败");
      },
    );
    assert.equal(await f.controller.command({ action, fail: true }), false);
    await f.controller.refresh();
    assert.deepEqual(f.view.state.guide, originalGuide);
    assert.equal(await f.controller.command({ action }), true);
    assert.deepEqual(f.view.state.guide, f.coreState.guide);
    await f.controller.refresh();
    assert.deepEqual(f.view.state.guide, f.coreState.guide);
    assert.equal(f.facts.size, 1);
    assert.equal(f.view.state.practiceCount, 1);
    f.controller.dispose();
  }
});
