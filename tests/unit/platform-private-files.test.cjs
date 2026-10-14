"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensurePrivateDirectory,
  writePrivateJson,
  readPrivateJson,
  assertPrivate,
} = require("../../electron/services/platform/private-files.cjs");

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-private-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("系统临时目录上的私有文件可用，不因 macOS /tmp 或 /var 前缀软链接误拒", (t) => {
  if (process.platform === "win32") return t.skip("Windows 走 ACL，见同文件 NTFS 用例");
  const root = workspace(t);
  const directory = path.join(root, "secret");
  ensurePrivateDirectory(directory);
  const file = path.join(directory, "token.json");
  writePrivateJson(file, { format: "leximeet.test/1", os: process.platform });
  assert.equal(readPrivateJson(file).os, process.platform);
  assert.doesNotThrow(() => assertPrivate(directory, { directory: true }));
});

test("POSIX 私有目录拒绝组/其他权限与符号链接", (t) => {
  if (process.platform === "win32") return t.skip("Windows 走 ACL，见同文件 NTFS 用例");
  const root = workspace(t);
  const directory = path.join(root, "secret");
  ensurePrivateDirectory(directory);
  const file = path.join(directory, "token.json");
  writePrivateJson(file, { format: "leximeet.test/1", ok: true });
  assert.deepEqual(readPrivateJson(file).ok, true);
  fs.chmodSync(file, 0o644);
  assert.throws(() => assertPrivate(file), /UNSAFE_PRIVATE_PATH/);
  const link = path.join(directory, "alias");
  fs.symlinkSync(file, link);
  assert.throws(() => assertPrivate(link), /UNSAFE_PRIVATE_PATH/);
});

test("Windows NTFS 用 icacls 去掉 Everyone/Users", (t) => {
  if (process.platform !== "win32") return t.skip("需要真实 NTFS 与 icacls");
  const root = workspace(t);
  const directory = path.join(root, "secret");
  ensurePrivateDirectory(directory, { platform: "win32" });
  const file = path.join(directory, "token.json");
  writePrivateJson(file, { format: "leximeet.test/1", ok: true }, { platform: "win32" });
  assert.equal(readPrivateJson(file, { platform: "win32" }).ok, true);
  const listing = require("node:child_process").execFileSync("icacls", [file], {
    encoding: "utf8",
  });
  assert.doesNotMatch(listing, /Everyone/i);
  assert.doesNotMatch(listing, /BUILTIN\\Users/i);
});

test("Windows ACL 断言拒绝 Everyone、Users 与 Authenticated Users", (t) => {
  if (process.platform !== "win32") return t.skip("需要真实 NTFS 与 icacls");
  const { execFileSync } = require("node:child_process");
  const { assertWindowsPrivate } = require("../../electron/services/platform/win32-acl.cjs");
  const root = workspace(t);
  const directory = path.join(root, "secret");
  ensurePrivateDirectory(directory, { platform: "win32" });
  assert.doesNotThrow(() => assertPrivate(directory, { directory: true, platform: "win32" }));
  for (const trustee of ["Everyone", "*S-1-5-32-545", "*S-1-5-11"]) {
    execFileSync("icacls", [directory, "/grant", `${trustee}:(R)`, "/Q"], {
      windowsHide: true,
    });
    assert.throws(() => assertWindowsPrivate(directory), /UNSAFE_PRIVATE_PATH/);
    execFileSync("icacls", [directory, "/remove:g", trustee, "/Q"], {
      windowsHide: true,
    });
  }
  ensurePrivateDirectory(directory, { platform: "win32" });
  assert.doesNotThrow(() => assertWindowsPrivate(directory));
});
