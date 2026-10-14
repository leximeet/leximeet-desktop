"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { coreStartTimeoutMs } = require("../../electron/services/java-runtime.cjs");
const { descriptorWaitMs } = require("../../scripts/install-smoke.cjs");

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
