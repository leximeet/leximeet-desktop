"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("词典下载只走 HTTPS 重试，不回退本机代理端口", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../scripts/prepare-dictionary.cjs"),
    "utf8",
  );
  assert.doesNotMatch(source, /7897/);
  assert.doesNotMatch(source, /12334/);
  assert.match(source, /attempts = 3/);
  assert.match(source, /\.runtime\/dictionary-source/);
  assert.match(source, /词典下载只接受 HTTPS/);
});
