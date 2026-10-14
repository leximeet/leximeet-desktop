"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWindowsJavaw } = require("../../scripts/build-runtime.cjs");

test("非 Windows 不改 jlink 镜像", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-jlink-posix-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(ensureWindowsJavaw(root, root, "linux"), null);
  assert.equal(fs.existsSync(path.join(root, "bin", "javaw.exe")), false);
});

test("Windows 镜像缺少 javaw 时从宿主 JDK 拷入", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-jlink-win-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const image = path.join(root, "image");
  const home = path.join(root, "jdk");
  fs.mkdirSync(path.join(home, "bin"), { recursive: true });
  fs.writeFileSync(path.join(home, "bin", "javaw.exe"), "host-javaw");
  const copied = ensureWindowsJavaw(image, home, "win32");
  assert.equal(copied, path.join(image, "bin", "javaw.exe"));
  assert.equal(fs.readFileSync(copied, "utf8"), "host-javaw");
  assert.equal(ensureWindowsJavaw(image, home, "win32"), copied);
});

test("Windows 宿主没有 javaw 时拒绝出包", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-jlink-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => ensureWindowsJavaw(root, root, "win32"), /javaw\.exe/);
});
