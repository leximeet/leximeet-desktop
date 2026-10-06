"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { TextDictionaryService } = require("../../electron/services/text-dictionary.cjs");
const {
  MANIFEST_SHA,
  INDEX_VERSION,
} = require("../../electron/services/text-dictionary-index.cjs");

// 单元范围只验证 Main 的活动指针与失败收尾；真实 SQLite / Core / Full 由原生套件验证。
async function fixture(
  t,
  fetchImpl = async () => {
    throw new Error("测试禁止外部网络");
  },
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-dict-policy-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const bundledPath = path.join(directory, "bundle");
  fs.mkdirSync(bundledPath);
  const payload = Buffer.from("main-policy-fixture");
  fs.writeFileSync(path.join(bundledPath, "core-text.sqlite"), payload);
  fs.writeFileSync(
    path.join(bundledPath, "core-text.sqlite.json"),
    JSON.stringify({
      edition: "core-text",
      version: "0.0.3",
      manifestSha: MANIFEST_SHA,
      indexVersion: INDEX_VERSION,
      entryCount: 117902,
      indexSha: createHash("sha256").update(payload).digest("hex"),
    }),
  );
  fs.copyFileSync(
    path.resolve(__dirname, "../../resources/dictionary/release.json"),
    path.join(bundledPath, "release.json"),
  );
  const mounts = [];
  const service = new TextDictionaryService({
    core: {
      async request(_route, _method, data) {
        mounts.push(data);
      },
    },
    profile: { coreDir: path.join(directory, "profile") },
    bundledPath,
    fetchImpl,
  });
  t.after(() => service.close());
  return { service, mounts };
}
test("损坏活动指针可以离线回到随包 Core，不访问网络", async (t) => {
  const { service, mounts } = await fixture(t);
  fs.writeFileSync(service.pointer, "{interrupted");
  await service.ensure();
  assert.equal(service.status().active.entryCount, 117902);
  assert.equal(mounts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(service.pointer)).active.edition, "core-text");
});
test("旧公共索引指针回到当前随包索引，私人资料与旧缓存文件保留", async (t) => {
  const { service, mounts } = await fixture(t);
  const personal = path.join(path.dirname(service.directory), "personal-fixture.sqlite");
  fs.writeFileSync(personal, "private-data");
  const oldFile = path.join(service.directory, "old-public.sqlite");
  fs.writeFileSync(oldFile, "old-public-cache");
  fs.writeFileSync(
    service.pointer,
    JSON.stringify({
      active: {
        fileName: "old-public.sqlite",
        indexVersion: INDEX_VERSION - 1,
      },
    }),
  );
  await service.ensure();
  assert.equal(mounts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(service.pointer)).active.indexVersion, INDEX_VERSION);
  assert.equal(fs.readFileSync(personal, "utf8"), "private-data");
  assert.equal(fs.readFileSync(oldFile, "utf8"), "old-public-cache");
});
test("过期随包公共索引明确拒绝，不能继续挂载慢查询缓存", async (t) => {
  const { service, mounts } = await fixture(t);
  const infoFile = path.join(service.bundledPath, "core-text.sqlite.json");
  const info = JSON.parse(fs.readFileSync(infoFile));
  info.indexVersion = INDEX_VERSION - 1;
  fs.writeFileSync(infoFile, JSON.stringify(info));
  await assert.rejects(service.ensure(), /随包词典索引版本不兼容/);
  assert.equal(mounts.length, 0);
  assert.equal(fs.existsSync(service.pointer), false);
});
test("词典空间不足在下载前失败并保留原活动指针", async (t) => {
  let downloads = 0;
  const { service } = await fixture(t, async () => {
    downloads++;
    throw new Error("不应下载");
  });
  await service.ensure();
  const prior = fs.readFileSync(service.pointer, "utf8");
  t.mock.method(fs, "statfsSync", () => ({ bavail: 0, bsize: 4096 }));
  await assert.rejects(service.action({ action: "install", edition: "full-text" }), /空间不足/);
  assert.equal(downloads, 0);
  assert.equal(service.status().busy, false);
  assert.equal(fs.readFileSync(service.pointer, "utf8"), prior);
  assert.equal(
    fs.readdirSync(service.directory).some((name) => name.startsWith("install-")),
    false,
  );
});
test("损坏下载分片不会激活或写入成功缓存，旧 Core 可继续使用", async (t) => {
  const { service, mounts } = await fixture(t, async () => new Response("corrupt-asset"));
  await service.ensure();
  const prior = fs.readFileSync(service.pointer, "utf8");
  await assert.rejects(service.action({ action: "install", edition: "full-text" }), /校验失败/);
  assert.equal(mounts.length, 1);
  assert.equal(service.status().progress.state, "failed");
  assert.equal(service.status().busy, false);
  assert.equal(fs.readFileSync(service.pointer, "utf8"), prior);
  assert.equal(fs.existsSync(path.join(service.directory, "assets/DATA-LICENSE.md")), false);
});
