"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  PluginCaptureNotifications,
} = require("../../electron/services/plugin-capture-notifications.cjs");
class Notice extends EventEmitter {
  static isSupported() {
    return true;
  }
  constructor(options) {
    super();
    this.options = options;
  }
  show() {
    this.emit("show");
  }
  close() {
    this.emit("close");
  }
}
const uuid = (number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const commit = (number = 1) => ({
  workspaceId: uuid(10),
  generation: uuid(11),
  eventId: uuid(number),
  word: "resilient",
  pluginName: "IDEA 插件",
});
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-capture-notices-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let enabled = true;
  const settings = async () => ({ pluginCaptureNotificationsEnabled: enabled });
  const create = () =>
    new PluginCaptureNotifications({
      Notification: Notice,
      profile: { root },
      settings,
      ...options,
    });
  const service = create();
  t.after(() => service.close());
  return { service, create, root, enable: (value) => (enabled = value) };
}
test("任意插件成功回执发送通知，只显示词与插件名，不泄露原文或认证", async (t) => {
  const f = fixture(t);
  await f.service.captureCommitted({
    ...commit(),
    originalSentence: "private text",
    sessionToken: "secret",
  });
  assert.equal(f.service.snapshot().sentCount, 1);
  const notice = [...f.service.notices][0];
  assert.deepEqual(notice.options, {
    icon: require("../../electron/services/notification-icon.cjs").NOTIFICATION_ICON,
    title: "插件采集成功",
    body: "IDEA 插件已保存“resilient”的遇见。",
    silent: true,
  });
  assert(!JSON.stringify(notice.options).includes("secret"));
  await f.service.captureCommitted(commit(2));
  assert.equal(f.service.snapshot().sentCount, 2);
});
test("重复安全语境被 Core 抑制后，不发送伪成功采集通知", async (t) => {
  const f = fixture(t);
  await f.service.captureCommitted({ ...commit(), captureStatus: "duplicate-context" });
  assert.equal(f.service.snapshot().sentCount, 0);
  assert.equal(f.service.notices.size, 0);
});
test("并发重放及重启后同一事件只通知一次，同UUID在不同工作区不混淆", async (t) => {
  const f = fixture(t);
  await Promise.all([f.service.captureCommitted(commit()), f.service.captureCommitted(commit())]);
  assert.equal(f.service.snapshot().sentCount, 1);
  f.service.close();
  const restored = f.create();
  t.after(() => restored.close());
  await restored.captureCommitted(commit());
  assert.equal(restored.snapshot().sentCount, 0);
  await restored.captureCommitted({ ...commit(), workspaceId: uuid(12) });
  assert.equal(restored.snapshot().sentCount, 1);
  const cache = fs.readFileSync(restored.file, "utf8");
  assert(!cache.includes("resilient"));
  assert(!cache.includes(uuid(1)));
});
test("关闭后采集仍消费回执，重新开启不补发，新的采集正常通知", async (t) => {
  const f = fixture(t);
  f.enable(false);
  await f.service.captureCommitted(commit());
  assert.equal(f.service.snapshot().sentCount, 0);
  f.enable(true);
  await f.service.captureCommitted(commit());
  assert.equal(f.service.snapshot().sentCount, 0);
  await f.service.captureCommitted(commit(2));
  assert.equal(f.service.snapshot().sentCount, 1);
});
test("通知失败或系统不支持不拒绝成功采集，失败也不重复发送", async (t) => {
  class Failed extends Notice {
    show() {
      this.emit("failed");
    }
  }
  const f = fixture(t, { Notification: Failed });
  await f.service.captureCommitted(commit());
  assert.equal(f.service.snapshot().sentCount, 0);
  assert.match(f.service.snapshot().lastError, /资料已保存/);
  await f.service.captureCommitted(commit());
  assert.equal(f.service.notices.size, 1);
  class Unsupported extends Notice {
    static isSupported() {
      return false;
    }
  }
  const disabled = new PluginCaptureNotifications({
    Notification: Unsupported,
    profile: { root: path.join(f.root, "unsupported") },
    settings: async () => ({}),
  });
  t.after(() => disabled.close());
  await disabled.captureCommitted(commit());
  assert.match(disabled.snapshot().lastError, /资料仍已保存/);
});
test("关闭期间等待设置的回调不发送通知，通知缓存有界且损坏时保留原文件", async (t) => {
  let release;
  const f = fixture(t, {
    settings: () => new Promise((resolve) => (release = resolve)),
    maximumReceipts: 2,
  });
  const pending = f.service.captureCommitted(commit());
  await new Promise((resolve) => setImmediate(resolve));
  f.service.close();
  release({});
  await pending;
  assert.equal(f.service.notices.size, 0);
  const bounded = f.create();
  // 本场缓存边界使用独立且立即可读的设置。
  bounded.settings = async () => ({});
  t.after(() => bounded.close());
  for (let i = 1; i <= 3; i++) await bounded.captureCommitted(commit(i));
  assert.equal(bounded.seen.size, 2);
  const damaged = "{broken";
  fs.writeFileSync(bounded.file, damaged, { mode: 0o600 });
  bounded.close();
  const restored = f.create();
  restored.settings = async () => ({});
  t.after(() => restored.close());
  await restored.captureCommitted(commit(4));
  assert.equal(fs.readFileSync(restored.file, "utf8"), damaged);
});
