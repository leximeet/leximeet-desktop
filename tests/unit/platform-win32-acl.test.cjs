"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const {
  namedPipeAclScript,
  assertNamedPipeExclusive,
  PIPE_FORBIDDEN_SIDS,
} = require("../../electron/services/platform/win32-acl.cjs");
const {
  windowsSystem32Binary,
  windowsPowerShellBinary,
} = require("../../electron/services/platform/identity.cjs");

test("命名管道 ACL 脚本用环境变量传路径，不用 JSON.stringify 嵌双引号", () => {
  const script = namedPipeAclScript("Restrict");
  assert.match(script, /\$env:LEXIMEET_PIPE_PATH/);
  assert.doesNotMatch(script, /Restrict\("/);
  assert.doesNotMatch(script, /JSON\.stringify/);
  const inspect = namedPipeAclScript("Inspect");
  assert.match(inspect, /Inspect\(\$env:LEXIMEET_PIPE_PATH\)/);
  const pipe = "\\\\.\\pipe\\leximeet-mcp-deadbeef-aaaaaaaaaaaaaaaaaaaa-01234567";
  assert.equal(script.includes(JSON.stringify(pipe)), false);
});

test("命名管道 ACL 先按 SE_FILE_OBJECT 找 \\\\.\\pipe\\ 名，再回退内核对象", () => {
  const script = namedPipeAclScript("Restrict");
  assert.match(script, /SE_FILE_OBJECT = 1/);
  assert.match(script, /SE_KERNEL_OBJECT = 6/);
  assert.match(script, /foreach \(var type in Types\(\)\)/);
  assert.match(script, /prefix = @"\\\\\.\\pipe\\"/);
  assert.match(script, /UNSAFE_AFTER_RESTRICT/);
  assert.match(script, /;LA\)/);
  const inspect = namedPipeAclScript("Inspect");
  assert.match(inspect, /SE_FILE_OBJECT = 1/);
  assert.match(inspect, /foreach \(var type in Types\(\)\)/);
});

test("icacls / reg / whoami / taskkill 固定 System32 根下的完整路径", () => {
  for (const name of ["icacls.exe", "reg.exe", "whoami.exe", "taskkill.exe"]) {
    const resolved = windowsSystem32Binary(name);
    assert.match(resolved, /System32/i);
    assert.doesNotMatch(resolved, /WindowsPowerShell/i);
    assert.match(resolved, new RegExp(`${name.replace(".", "\\.")}$`, "i"));
    assert.equal(path.isAbsolute(resolved) || resolved.includes("\\"), true);
  }
  assert.throws(
    () => windowsSystem32Binary("powershell.exe"),
    /WINDOWS_POWERSHELL_NOT_IN_SYSTEM32_ROOT/,
  );
});

test("powershell.exe 解析到 System32\\WindowsPowerShell\\v1.0", () => {
  const resolved = windowsPowerShellBinary();
  assert.match(resolved, /WindowsPowerShell[/\\]v1\.0[/\\]powershell\.exe$/i);
  assert.equal(path.isAbsolute(resolved) || resolved.includes("\\"), true);
});

test("管道 DACL 断言拒绝 Everyone / Users / 匿名", () => {
  const sid = "S-1-5-21-1-2-3-1001";
  const ok = assertNamedPipeExclusive(`D:P(A;;GA;;;${sid})(A;;GA;;;S-1-5-18)`, { sid });
  assert.equal(ok.hasSystem, true);
  const mismatch = assertNamedPipeExclusive(`D:P(A;;GA;;;${sid})(A;;GA;;;SY)`, {
    sid: "S-1-5-21-9-9-9-9",
  });
  assert.equal(mismatch.hasSystem, true);
  const aliased = assertNamedPipeExclusive("D:PAI(A;;FA;;;LA)(A;;FA;;;SY)", {
    sid: "S-1-5-21-1643835476-1616584234-1346609752-500",
  });
  assert.equal(aliased.hasSystem, true);
  for (const forbidden of PIPE_FORBIDDEN_SIDS) {
    assert.throws(
      () => assertNamedPipeExclusive(`D:P(A;;GA;;;${sid})(A;;GR;;;${forbidden})`, { sid }),
      /UNSAFE_NAMED_PIPE_DACL/,
    );
  }
  assert.throws(
    () => assertNamedPipeExclusive(`D:P(A;;GA;;;${sid})(A;;GR;;;WD)`, { sid }),
    /UNSAFE/,
  );
  assert.throws(
    () => assertNamedPipeExclusive(`D:P(A;;GA;;;${sid})(A;;GR;;;AN)`, { sid }),
    /UNSAFE/,
  );
});
