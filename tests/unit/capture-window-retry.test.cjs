"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { CaptureWindows } = require("../../electron/services/capture-window.cjs");

// 只替换 OS 窗口副作用，直接执行生产权限与显式重试路由，不创建真实窗口。
function fixture(deliveryRetryRequired) {
  const calls = { reads: 0, notices: 0, shows: 0, focuses: 0 };
  class BrowserWindow extends EventEmitter {
    constructor() {
      super();
      this.webContents = new EventEmitter();
      this.webContents.send = () => {};
      this.webContents.setWindowOpenHandler = () => {};
    }
    async loadURL() {}
    isDestroyed() {
      return false;
    }
    show() {
      calls.shows++;
    }
    focus() {
      calls.focuses++;
    }
    hide() {}
    destroy() {}
  }
  const inbox = {
    mode: "system",
    items: new Map([["original-id", { status: "failed" }]]),
    snapshot: () => ({ deliveryRetryRequired }),
    retryFailedNotifications() {
      calls.notices++;
    },
    ready() {},
    cancel() {},
  };
  const service = new CaptureWindows({
    BrowserWindow,
    sourceUrl: "file:///isolated/index.html",
    projectDir: "/isolated",
    silent: false,
    inbox,
    retryClipboard: async () => {
      calls.reads++;
      return { retried: true };
    },
  });
  return { service, calls };
}

test("主窗明确重试可复核并重发通知，只有通知仍未送达才显式打开待处理窗口", async () => {
  for (const failed of [false, true]) {
    const f = fixture(failed);
    assert.deepEqual(await f.service.action({ action: "retryClipboard" }, {}), {
      retried: true,
    });
    assert.equal(f.calls.reads, 1);
    assert.equal(f.calls.notices, 1);
    assert.equal(f.calls.shows, failed ? 1 : 0);
    assert.equal(f.calls.focuses, failed ? 1 : 0);
    f.service.close();
  }
});

test("采集子窗不能读系统剪贴板；重试动作拒绝夹带正文/操作编号", async () => {
  const f = fixture(false),
    popup = {};
  f.service.windows.set("inbox", {
    isDestroyed: () => false,
    webContents: popup,
  });
  await assert.rejects(f.service.action({ action: "retryClipboard" }, popup), /主窗口/);
  for (const extra of [{ context: "private" }, { id: "original-id" }, { collect: true }])
    await assert.rejects(f.service.action({ action: "retryClipboard", ...extra }, {}), /主窗口/);
  assert.equal(f.calls.reads, 0);
  assert.equal(f.calls.notices, 0);
});

test("采集窗拒绝旧释义输入，不能通过隐藏字段写入个人释义", async () => {
  const f = fixture(false);
  await assert.rejects(
    f.service.action({ action: "save", mode: "capture", word: "node", meaning: "旧释义" }, {}),
    /采集参数无效/,
  );
  assert.equal(f.calls.reads, 0);
});
