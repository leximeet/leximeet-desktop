"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  NativeCaptureService,
  clipboardWords,
} = require("../../electron/services/native-capture.cjs");

test("默认关闭时零读取零写入；启用后才预览当前文本且不保存历史", async () => {
  const clipboard = {
    reads: 0,
    writes: 0,
    value: "resilient",
    readText() {
      this.reads += 1;
      return this.value;
    },
    writeText() {
      this.writes += 1;
    },
  };
  const previews = [];
  const shortcuts = [];
  const capture = new NativeCaptureService({
    clipboard,
    globalShortcut: {
      register(accelerator, fn) {
        shortcuts.push({ accelerator, fn });
        return true;
      },
      unregister() {},
      unregisterAll() {},
    },
    sendPreview: (value) => previews.push(value),
    intervalMs: 20,
  });
  capture.apply({
    clipboardCaptureEnabled: false,
    globalShortcutEnabled: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(clipboard.reads, 0);
  assert.equal(clipboard.writes, 0);
  assert.equal(capture.snapshot().historyStored, false);
  capture.apply({ clipboardCaptureEnabled: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(clipboard.reads >= 1);
  assert.equal(clipboard.writes, 0);
  assert.equal(previews[0].text, "resilient");
  clipboard.value = "ephemeral";
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(previews.at(-1).text, "ephemeral");
  capture.apply({
    clipboardCaptureEnabled: false,
    globalShortcutEnabled: true,
  });
  assert.equal(capture.snapshot().shortcutEnabled, true);
  capture.close();
  assert.equal(capture.snapshot().clipboardEnabled, false);
  assert.equal(capture.snapshot().shortcutEnabled, false);
});

test("隐藏/临时剪贴板格式在读正文之前忽略，不保存长文本或其他应用快捷键", async () => {
  let reads = 0;
  const previews = [],
    unregistered = [];
  const clipboard = {
    availableFormats: async () => ["org.nspasteboard.ConcealedType"],
    readText: async () => {
      reads++;
      return "private-text";
    },
  };
  const capture = new NativeCaptureService({
    clipboard,
    intervalMs: 60000,
    sendPreview: (value) => previews.push(value),
    globalShortcut: {
      register: () => true,
      unregister: (key) => unregistered.push(key),
      unregisterAll: () => {
        throw new Error("不能清理其他快捷键");
      },
    },
  });
  try {
    capture.apply({
      clipboardCaptureEnabled: true,
      globalShortcutEnabled: true,
    });
    await capture.poll();
    assert.equal(reads, 0);
    assert.deepEqual(previews, []);
    clipboard.availableFormats = async () => ["text/plain"];
    clipboard.readText = async () => "a".repeat(1000);
    await capture.poll();
    assert.equal(capture.snapshot().historyStored, false);
    assert.deepEqual(previews, []);
    capture.close();
    assert.deepEqual(unregistered, [capture.accelerator]);
  } finally {
    capture.close();
  }
});
test("异步读取中停用或退出，迟到正文不能重新出现，重复短词只有一个预览", async () => {
  let resolve;
  const previews = [];
  const clipboard = { readText: () => new Promise((done) => (resolve = done)) };
  const capture = new NativeCaptureService({
    clipboard,
    intervalMs: 60000,
    sendPreview: (value) => previews.push(value),
  });
  try {
    capture.apply({ clipboardCaptureEnabled: true });
    const read = capture.poll();
    capture.apply({ clipboardCaptureEnabled: false });
    resolve("serendipity");
    await read;
    assert.deepEqual(previews, [{ source: "cleared" }]);
    clipboard.readText = async () => "serendipity";
    capture.apply({ clipboardCaptureEnabled: true });
    await capture.poll();
    await capture.poll();
    assert.equal(previews.filter((value) => value.text).length, 1);
  } finally {
    capture.close();
  }
});

test("普通句子、标点、换行和中英混排逐词去重；URL 和邮箱不会拆成噪声", () => {
  assert.deepEqual(clipboardWords("Apple, banana, orange!"), ["apple", "banana", "orange"]);
  assert.deepEqual(clipboardWords("读到 Apple\nbanana Apple, can't co-operate."), [
    "apple",
    "banana",
    "can't",
    "co-operate",
  ]);
  assert.deepEqual(clipboardWords("https://example.com user@example.com apple"), ["apple"]);
  assert.deepEqual(clipboardWords("x".repeat(20001)), []);
});

test("明确重试只检查当前文本一次，保留 lastText 和周期，普通 poll 仍不重发", async () => {
  const previews = [];
  const capture = new NativeCaptureService({
    clipboard: { readText: () => "Alpha." },
    intervalMs: 60000,
    sendPreview: (value) => previews.push(value),
  });
  try {
    assert.deepEqual(await capture.retryPreview(), { retried: false });
    assert.equal(capture.reads, 0);
    capture.apply({ clipboardCaptureEnabled: true });
    const timer = capture.timer;
    await capture.poll();
    await capture.poll();
    assert.equal(previews.length, 1);
    assert.deepEqual(await capture.retryPreview(), { retried: true });
    assert.equal(previews.length, 2);
    assert.equal(capture.lastText, "Alpha.");
    assert.equal(capture.timer, timer);
    await capture.poll();
    assert.equal(previews.length, 2);
    assert.equal(capture.snapshot().retryCount, 1);
    assert.equal(capture.snapshot().retryAvailable, true);
  } finally {
    capture.close();
  }
});

test("重试遵守敏感格式与停用边界，正在预检时不会重入或重复读取", async () => {
  let reads = 0,
    release;
  const previews = [];
  const clipboard = {
    availableFormats: () => ["org.nspasteboard.ConcealedType"],
    readText: () => {
      reads++;
      return "Alpha.";
    },
  };
  const capture = new NativeCaptureService({
    clipboard,
    intervalMs: 60000,
    sendPreview: (preview) => {
      previews.push(preview);
      if (preview.source === "clipboard")
        return new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  try {
    capture.apply({ clipboardCaptureEnabled: true });
    assert.deepEqual(await capture.retryPreview(), { retried: false });
    assert.equal(reads, 0);
    clipboard.availableFormats = () => ["text/plain"];
    const pending = capture.retryPreview();
    await new Promise(setImmediate);
    assert.equal(capture.snapshot().retryAvailable, false);
    assert.deepEqual(await capture.retryPreview(), { retried: false });
    await capture.poll();
    assert.equal(reads, 1);
    capture.apply({ clipboardCaptureEnabled: false });
    release();
    await pending;
    assert.equal(capture.snapshot().retryAvailable, false);
    assert.equal(previews.length, 2);
    assert.equal(previews[1].source, "cleared");
  } finally {
    capture.close();
  }
});
