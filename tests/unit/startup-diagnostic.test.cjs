"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { coreEnvironment, startupFailure } = require("../../electron/services/java-runtime.cjs");

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
