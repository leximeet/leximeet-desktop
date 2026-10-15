"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { stubOutput } = require("../../scripts/build-run-as-node.cjs");

test("PE stub 编入 .runtime，不改 resources 源码树", () => {
  assert.equal(
    path.relative(path.resolve(__dirname, "../.."), stubOutput).split(path.sep).join("/"),
    ".runtime/native/leximeet-run-as-node.exe",
  );
  const pkg = require("../../package.json");
  assert.equal(pkg.build.win.extraResources[0].from, ".runtime/native/leximeet-run-as-node.exe");
});
