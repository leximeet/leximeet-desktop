"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const {
  coreEnvironment,
  startupFailure,
  attachStderr,
} = require("../../electron/services/java-runtime.cjs");

test("Java 注入参数不传给子进程，原环境保持不变", () => {
  const source = {
    PATH: "fixture",
    JAVA_TOOL_OPTIONS: "private marker",
    JDK_JAVA_OPTIONS: "other marker",
    _JAVA_OPTIONS: "third marker",
  };
  assert.deepEqual(coreEnvironment(source), { PATH: "fixture" });
  assert.equal(source.JAVA_TOOL_OPTIONS, "private marker");
});

test("启动 UI 仅使用固定错误分类，不显示 JVM 原文或任意参数", () => {
  const privateText = "private/path password=secret SQL=select-private-notes";
  for (const diagnostic of [
    privateText,
    `Picked up JAVA_TOOL_OPTIONS: ${privateText}\nCore 启动失败：[DATA_CORRUPTED] ${privateText}`,
    `Core 启动失败：[UNKNOWN_CODE] ${privateText}`,
  ]) {
    const message = startupFailure(diagnostic, 1);
    assert.equal(message.includes("private"), false);
    assert.equal(message.includes("secret"), false);
    assert.equal(message.includes("SQL"), false);
  }
  assert.match(startupFailure("Core 启动失败：[DATA_CORRUPTED] 任意原文", 1), /原文件已保留/);
  assert.match(
    startupFailure("Core 启动失败：[UNSUPPORTED_DATA_SCHEMA] schema 8", 1),
    /匹配的应用/,
  );
});

test("等 close 再读 stderr，DATA_IN_USE 不会被误报成通用退出码", async () => {
  const child = spawn(
    process.execPath,
    ["-e", "process.stderr.write('Core 启动失败：[DATA_IN_USE] locked\\n'); process.exit(1);"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const readDiagnostic = attachStderr(child);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(code, 1);
  assert.match(startupFailure(readDiagnostic(), code), /DATA_IN_USE/);
  assert.match(startupFailure(readDiagnostic(), code), /另一应用使用/);
});
