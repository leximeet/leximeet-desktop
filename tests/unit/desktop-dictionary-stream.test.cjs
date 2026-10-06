"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const {
  jsonLines,
  manifest,
  MANIFEST_SHA,
  assetsFor,
} = require("../../electron/services/text-dictionary-index.cjs");
const path = require("node:path");
test("JSONL 流跨 UTF-8 与长记录分块无截断；末行无换行也能读取", async () => {
  const records = [
    { word: "词遇", text: "汉字".repeat(40000) },
    { word: "alpha", text: "第二行" },
  ];
  const bytes = Buffer.from(records.map(JSON.stringify).join("\n"));
  const pieces = [];
  for (let i = 0; i < bytes.length; i += 17) pieces.push(bytes.subarray(i, i + 17));
  const loaded = [];
  for await (const value of jsonLines(Readable.from(pieces))) loaded.push(JSON.parse(value));
  assert.deepEqual(loaded, records);
});
test("固定发布清单与 Core/Full 增量资产预算一致", () => {
  const release = manifest(path.resolve(__dirname, "../../resources/dictionary"));
  assert.equal(MANIFEST_SHA.length, 64);
  const core = assetsFor(release, "core-text"),
    full = assetsFor(release, "full-text");
  assert.ok(core.every((name) => full.includes(name)));
  assert.equal(
    full
      .filter((name) => !core.includes(name))
      .reduce((sum, name) => sum + release.assets[name].bytes, 0),
    45305983,
  );
});
