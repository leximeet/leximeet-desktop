"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { coreStartTimeoutMs, reclaimMarkers } = require("../../electron/services/java-runtime.cjs");
const {
  descriptorWaitMs,
  appLaunchArgs,
  prepareIsolatedHome,
} = require("../../scripts/install-smoke.cjs");

test("Windows 首次启动握手宽于 POSIX，覆盖 Defender 实时扫描", () => {
  assert.equal(coreStartTimeoutMs("darwin"), 45000);
  assert.equal(coreStartTimeoutMs("linux"), 45000);
  assert.equal(coreStartTimeoutMs("win32"), 120000);
  assert.ok(coreStartTimeoutMs("win32") > coreStartTimeoutMs("linux"));
});

test("安装冒烟等待长于产品握手，Windows 仍不短于 POSIX 冒烟预算", () => {
  assert.ok(descriptorWaitMs("linux") > coreStartTimeoutMs("linux"));
  assert.ok(descriptorWaitMs("win32") > coreStartTimeoutMs("win32"));
  assert.ok(descriptorWaitMs("win32") > descriptorWaitMs("linux"));
  assert.equal(descriptorWaitMs("linux"), 90000);
  assert.equal(descriptorWaitMs("win32"), 150000);
});

test("Windows 安装冒烟给 Electron 加 --disable-gpu，避免无显示 runner 挂住", () => {
  assert.deepEqual(appLaunchArgs([], "linux"), []);
  assert.deepEqual(appLaunchArgs([], "win32"), ["--disable-gpu"]);
  assert.equal(
    appLaunchArgs([], "win32").includes("--disable-software-rasterizer"),
    false,
    "关掉软件光栅会让无 GPU runner 直接崩溃",
  );
  assert.ok(
    appLaunchArgs(["--appimage-extract-and-run"], "linux").includes("--appimage-extract-and-run"),
  );
});

test("启动失败未占住目录时，stop 只按实例标记回收，不误杀同目录持锁进程", () => {
  assert.deepEqual(
    reclaimMarkers({
      instanceId: "abc123",
      dataDir: "C:\\\\tmp\\\\shared-core",
      ownedDirectory: false,
    }),
    ["leximeet.instance=abc123"],
  );
  assert.deepEqual(
    reclaimMarkers({
      instanceId: "abc123",
      dataDir: "C:\\\\tmp\\\\shared-core",
      ownedDirectory: true,
    }),
    ["leximeet.instance=abc123", "C:\\\\tmp\\\\shared-core"],
  );
  assert.deepEqual(reclaimMarkers({ ownedDirectory: true, dataDir: "" }), []);
});

test("隔离冒烟会创建 Windows AppData 目录，避免 Electron getPath 失败", (t) => {
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-smoke-home-"));
  t.after(() => fs.rmSync(profileDir, { recursive: true, force: true }));
  const env = {
    APPDATA: path.join(profileDir, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(profileDir, "AppData", "Local"),
  };
  prepareIsolatedHome(profileDir, env);
  assert.equal(fs.existsSync(env.APPDATA), true);
  assert.equal(fs.existsSync(env.LOCALAPPDATA), true);
});
