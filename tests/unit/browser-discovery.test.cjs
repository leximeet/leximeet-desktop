"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BrowserDiscovery } = require("../../electron/services/browser-discovery.cjs");
const manifest = {
  manifest_version: 3,
  name: "词遇-LexiMeet",
  permissions: ["nativeMessaging", "sidePanel"],
  background: { service_worker: "background.js" },
  options_ui: { page: "options.html" },
  side_panel: { default_path: "sidepanel.html" },
};
function fixture(t, name = "local") {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-discovery-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const calls = [];
  const service = new BrowserDiscovery({
    profile: { name },
    homeDir,
    platform: "darwin",
    connectionSettings: {
      registerDiscovered: async (...args) => calls.push(args),
    },
  });
  const root = path.join(homeDir, "Library/Application Support/Google/Chrome/Default");
  fs.mkdirSync(root, { recursive: true });
  const write = (file, value) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  return { homeDir, root, service, calls, write };
}
test("安装发现只识别词遇清单，自动来源精确且不读插件词库", async (t) => {
  const f = fixture(t);
  f.write(path.join(f.root, "Extensions", "a".repeat(32), "1.0.0_0/manifest.json"), manifest);
  f.write(path.join(f.root, "Extensions", "b".repeat(32), "1.0.0_0/manifest.json"), {
    ...manifest,
    name: "其他插件",
  });
  f.write(path.join(f.root, "Extensions", "c".repeat(32), "1.0.0_0/manifest.json"), manifest);
  f.write(path.join(f.root, "Preferences"), {
    extensions: { settings: { ["c".repeat(32)]: { state: 0 } } },
  });
  const sentinel = path.join(f.root, "History");
  fs.writeFileSync(sentinel, "不可读取或改变的用户资料");
  const state = await f.service.scan();
  assert.deepEqual(f.calls, [["chrome", ["a".repeat(32)]]]);
  assert.deepEqual(state.detected, [{ browser: "chrome", count: 1 }]);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "不可读取或改变的用户资料");
});
test("解压安装从配置的显式manifest发现，测试profile完全不扫描日常路径", async (t) => {
  const f = fixture(t);
  const installed = path.join(f.homeDir, "extension");
  f.write(path.join(installed, "manifest.json"), manifest);
  f.write(path.join(f.root, "Preferences"), {
    extensions: {
      settings: { ["d".repeat(32)]: { state: 1, path: installed } },
    },
  });
  await f.service.scan();
  assert.deepEqual(f.calls, [["chrome", ["d".repeat(32)]]]);
  for (const name of ["test", "demo", "dev", "preview"]) {
    f.service.profile = { name };
    f.calls.length = 0;
    await f.service.scan();
    f.service.start();
    assert.deepEqual(f.calls, []);
    assert.equal(f.service.timer, undefined);
    assert.equal(f.service.snapshot().isolated, true);
  }
});
test("外来注册失败只报告诊断，不覆盖或让学习启动失败", async (t) => {
  const f = fixture(t);
  f.write(path.join(f.root, "Extensions", "a".repeat(32), "1.0.0_0/manifest.json"), manifest);
  f.service.connectionSettings.registerDiscovered = async () => {
    throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
  };
  assert.match((await f.service.scan()).lastError, /未能自动启用/);
});
