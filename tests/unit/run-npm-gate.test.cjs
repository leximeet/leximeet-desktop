"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { DEFAULT_BUDGET_MS } = require("../../scripts/lib/run-npm-gate.cjs");
const { dumpProcessTree } = require("../../scripts/lib/dump-process-tree.cjs");

test("门禁脚本都有单步超时，避免静默挂死", () => {
  for (const script of [
    "test:unit",
    "test:core",
    "test:integration",
    "test:lmcp:transport",
    "test:mcp",
    "test:desktop",
  ]) {
    assert.ok(DEFAULT_BUDGET_MS[script] > 0, script);
  }
  assert.ok(DEFAULT_BUDGET_MS["test:integration"] <= 180000);
});

test("进程树诊断失败时不抛，只写 stderr", () => {
  assert.doesNotThrow(() =>
    dumpProcessTree("单元测试夹具", () => {
      throw new Error("tasklist missing");
    }),
  );
});
