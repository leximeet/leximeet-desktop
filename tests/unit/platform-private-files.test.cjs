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
