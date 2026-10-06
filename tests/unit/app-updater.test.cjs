"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { AppUpdater } = require("../../electron/services/app-updater.cjs");

test("未配置更新源不伪装为最新；损坏与取消删除未完成文件且不支持暂停", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-update-"));
  try {
    const empty = new AppUpdater({ downloadDir: root });
    const missing = await empty.check();
    assert.equal(missing.status, "not-configured");
    assert.equal(missing.pauseSupported, false);
    const bytes = Buffer.from("leximeet-update-bytes");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const feed = {
      assets: {
        [`${process.platform}-${process.arch}`]: {
          url: "https://updates.test/LexiMeet.bin",
          sha256,
          version: "9.9.9",
          size: bytes.length,
          range: true,
        },
      },
    };
    const calls = [];
    const updater = new AppUpdater({
      feedUrl: "https://updates.test/feed.json",
      downloadDir: root,
      currentVersion: "0.1.0",
      fetchImpl: async (url, options) => {
        calls.push({
          url: String(url),
          headers: options?.headers || {},
          range: options?.headers?.Range,
        });
        if (String(url).endsWith("feed.json")) return new Response(JSON.stringify(feed));
        return new Response(bytes);
      },
    });
    const available = await updater.check();
    assert.equal(available.status, "available");
    assert.equal(available.rangeSupported, true);
    assert.equal(available.pauseSupported, false);
    const older = new AppUpdater({
      feedUrl: "https://updates.test/feed.json",
      downloadDir: root,
      currentVersion: "10.0.0",
      fetchImpl: async (url) => {
        if (String(url).endsWith("feed.json")) return new Response(JSON.stringify(feed));
        throw new Error("更低版本不得开始下载");
      },
    });
    const skipped = await older.check();
    assert.equal(skipped.status, "older");
    const skippedDownload = await older.download();
    assert.equal(skippedDownload.status, "older");
    assert.equal(fs.existsSync(path.join(root, "LexiMeet-9.9.9.bin")), false);
    const downloaded = await updater.download();
    assert.equal(downloaded.status, "downloaded");
    assert.equal(downloaded.rangeUsed, false);
    assert.equal(downloaded.sha256, sha256);
    assert.equal(
      calls.some((item) => item.range),
      false,
    );
    fs.writeFileSync(path.join(root, "LexiMeet-9.9.9.bin"), "corrupt");
    const bad = new AppUpdater({
      feedUrl: "https://updates.test/feed.json",
      downloadDir: root,
      currentVersion: "0.1.0",
      fetchImpl: async (url) => {
        if (String(url).endsWith("feed.json")) return new Response(JSON.stringify(feed));
        return new Response(Buffer.from("not-the-bytes"));
      },
    });
    await assert.rejects(bad.download(), /校验失败/);
    assert.equal(fs.existsSync(path.join(root, "incomplete-9.9.9.part")), false);
    let assetRequestStarted;
    const assetRequest = new Promise((resolve) => {
      assetRequestStarted = resolve;
    });
    const cancellable = new AppUpdater({
      feedUrl: "https://updates.test/feed.json",
      downloadDir: root,
      currentVersion: "0.1.0",
      fetchImpl: async (url, options) => {
        if (String(url).endsWith("feed.json")) return new Response(JSON.stringify(feed));
        return new Promise((_, reject) => {
          assetRequestStarted();
          if (options.signal.aborted)
            return reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          options.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        });
      },
    });
    const pending = cancellable.download();
    // 等真实下载请求开始再取消；固定睡眠可能先触发 abort，使假 fetch 错过事件并挂起整套测试。
    let waitTimer;
    try {
      await Promise.race([
        assetRequest,
        new Promise((_, reject) => {
          waitTimer = setTimeout(() => reject(new Error("更新下载未启动")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(waitTimer);
      cancellable.inflight?.abort();
    }
    await assert.rejects(pending, /取消/);
    assert.equal(fs.existsSync(path.join(root, "incomplete-9.9.9.part")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
