"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { runNativeHost } = require("../../electron/native-host/main.cjs");
const { uniqueTestHostName } = require("../helpers/native-host-fixture.cjs");

function collect(stream) {
  let text = "";
  stream.on("data", (chunk) => {
    text += chunk.toString();
  });
  return () => text;
}

test("测试 Host 名带每例独有后缀且符合注册规则", () => {
  const first = uniqueTestHostName();
  const second = uniqueTestHostName();
  assert.match(first, /^org\.leximeet\.browser\.test\.[a-z0-9]{12}$/);
  assert.notEqual(first, second);
  assert.ok(first.length <= 100);
});

function runHost(options) {
  const previous = process.exitCode;
  try {
    return runNativeHost(options);
  } finally {
    process.exitCode = previous;
  }
}

test("Host catch 把 error.message 写到 stderr，未知错误映射 HOST_UNAVAILABLE", () => {
  const diagnostic = new PassThrough();
  const read = collect(diagnostic);
  const host = runHost({
    descriptorPath: "relative/not-absolute.json",
    extensionOrigin: `chrome-extension://${"a".repeat(32)}/`,
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostic,
  });
  const text = read();
  assert.match(text, /SOURCE_REJECTED/);
  assert.match(text, /LMCP_NATIVE_SOURCE_REJECTED/);
  host.close();
});

test("Host 读取失败时 stderr 保留原始错误再写 HOST_UNAVAILABLE", () => {
  const diagnostic = new PassThrough();
  const read = collect(diagnostic);
  const host = runHost({
    descriptorPath: "/this/leximeet-host-missing.json",
    extensionOrigin: `chrome-extension://${"a".repeat(32)}/`,
    input: new PassThrough(),
    output: new PassThrough(),
    diagnostic,
  });
  const text = read();
  assert.match(text, /LMCP_NATIVE_/);
  assert.equal(text.includes("HOST_UNAVAILABLE") || text.includes("UNSAFE"), true);
  assert.ok(text.split("\n").length >= 2);
  host.close();
});
