"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 测试只能使用已准备的固定公共资源；不会在 Electron 用例内临时请求外网。
function dictionarySource() {
  const root = path.resolve(__dirname, "../..");
  const candidates = [
    process.env.LEXIMEET_DICTIONARY_TEST_SOURCE,
    path.resolve(root, "../leximeet-dictionary/dist/v0.0.3"),
    path.join(root, ".runtime/dictionary-source/v0.0.3"),
  ];
  const selected = candidates
    .filter(Boolean)
    .find(
      (directory) =>
        fs.existsSync(path.join(directory, "release.json")) &&
        fs.existsSync(path.join(directory, "entries-full-delta-0011.jsonl.zst")),
    );
  if (!selected)
    throw new Error(
      "缺少 Full 测试物料，请先运行 bash scripts/test-desktop.sh --verify 准备固定资源",
    );
  return selected;
}
module.exports = { dictionarySource };
