const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { AppUpdater, compareVersions } = require("../../electron/services/app-updater.cjs");

function fixture(t, asset = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-review-update-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bytes = Buffer.from("verified");
  const value = {
    version: "2.0.0",
    url: "https://updates.test/app.bin",
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    ...asset,
  };
  const updater = new AppUpdater({
    downloadDir: path.join(root, "downloads"),
    feedUrl: "https://updates.test/feed.json",
    currentVersion: "1.0.0",
    fetchImpl: async (url) =>
      new Response(
        url.endsWith("feed.json")
          ? JSON.stringify({ assets: { [process.platform + "-" + process.arch]: value } })
          : bytes,
      ),
  });
  return { root, updater, value, bytes };
}

test("UPD-01：拒绝版本路径穿越、错误哈希、字节预算和非 HTTPS 下载源", async (t) => {
  for (const asset of [
    { version: "999.0/../../outside" },
    { sha256: "bad" },
    { size: -1 },
    { size: 2 ** 32 },
    { url: "file:///private/tmp/app.bin" },
  ]) {
    await assert.rejects(fixture(t, asset).updater.download());
  }
});

test("UPD-01：下载大小不符不发布候选；预发布版本顺序正确", async (t) => {
  const { updater, root } = fixture(t, { size: 1 });
  await assert.rejects(updater.download(), /大小|长度|体积/);
  assert.equal(fs.existsSync(path.join(root, "downloads", "LexiMeet-2.0.0.bin")), false);
  assert.ok(compareVersions("1.0.0-beta.2", "1.0.0-beta.11") < 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.11") > 0);
});

test("UPD-01：清单请求期间即可取消，同时拒绝第二次下载", async (t) => {
  const { updater } = fixture(t);
  updater.fetchImpl = (_url, options) =>
    new Promise((resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
    );
  const first = updater.download();
  assert.ok(updater.inflight, "开始异步读取清单前必须登记操作");
  await assert.rejects(updater.download(), /进行/);
  updater.inflight.abort();
  await assert.rejects(first, /取消/);
  assert.equal(updater.inflight, null);
});
