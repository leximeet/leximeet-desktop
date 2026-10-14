"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  ensureLauncher,
  writeNativeLauncher,
  readLaunchSidecar,
} = require("../../electron/services/platform/launcher.cjs");
const {
  quoteForShell,
  powershellQuote,
  posixQuote,
} = require("../../electron/services/platform/shell-quote.cjs");
const { commandNames } = require("../../electron/services/platform/process-names.cjs");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-launcher-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "LexiMeet");
  const shim = path.join(root, "shim.cjs");
  fs.writeFileSync(electron, "electron");
  fs.writeFileSync(shim, "shim");
  return { root, electron, shim };
}

test("POSIX 启动器是 shebang 脚本，配置不写 Electron 本体", (t) => {
  const f = workspace(t);
  const file = ensureLauncher({
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    platform: "linux",
  });
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^#!\/bin\/sh/);
  assert.match(text, /ELECTRON_RUN_AS_NODE=1/);
  assert.doesNotMatch(text, /--run-as-node/);
  assert.equal(path.basename(file), "leximeet-mcp");
});

test("Windows 启动器复制 PE stub 并写 sidecar，不用 .cmd", (t) => {
  const f = workspace(t);
  const stub = path.join(f.root, "stub.exe");
  fs.writeFileSync(stub, "MZ-stub");
  const file = ensureLauncher({
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    platform: "win32",
    stubPath: stub,
  });
  assert.equal(path.extname(file), ".exe");
  assert.equal(fs.readFileSync(file, "utf8"), "MZ-stub");
  const sidecar = readLaunchSidecar(file);
  assert.equal(sidecar.electron, f.electron);
  assert.equal(sidecar.script, f.shim);
  assert.equal(fs.existsSync(`${file}.cmd`), false);
});

test("缺少 PE stub 时 Windows 启动器明确失败，不降级到 cmd", (t) => {
  const f = workspace(t);
  assert.throws(
    () =>
      ensureLauncher({
        homeDir: f.root,
        electronExecutable: f.electron,
        shimPath: f.shim,
        platform: "win32",
        projectDir: f.root,
      }),
    /WINDOWS_PE_STUB_MISSING/,
  );
});

test("Native Host Windows 启动器同样走 sidecar", (t) => {
  const f = workspace(t);
  const stub = path.join(f.root, "stub.exe");
  const launcher = path.join(f.root, "host.exe");
  fs.writeFileSync(stub, "MZ-host");
  writeNativeLauncher({
    launcher,
    electronExecutable: f.electron,
    hostScript: f.shim,
    descriptorPath: path.join(f.root, "lmcp.json"),
    platform: "win32",
    stubPath: stub,
  });
  assert.equal(readLaunchSidecar(launcher).prefixArgs[0], path.join(f.root, "lmcp.json"));
});

test("复制命令按平台引号；探测名含 .exe", () => {
  assert.equal(posixQuote("a'b"), `'a'\\''b'`);
  assert.equal(powershellQuote("a'b"), `'a''b'`);
  assert.equal(quoteForShell("x", "win32"), `'x'`);
  assert.deepEqual(commandNames("cursor", "win32"), ["cursor.exe", "cursor"]);
  assert.deepEqual(commandNames("claude-code", "linux"), ["claude"]);
});

test("官方 SDK shell:false 不能直接跑 .cmd，锁定必须用 stub", (t) => {
  if (process.platform !== "win32") return t.skip("CreateProcess 语义只在 Windows 上验证");
  const f = workspace(t);
  const cmd = path.join(f.root, "leximeet-mcp.cmd");
  fs.writeFileSync(cmd, "@echo off\r\nexit /b 0\r\n");
  const result = spawnSync(cmd, [], { shell: false, encoding: "utf8" });
  assert.notEqual(result.status, 0);
});
