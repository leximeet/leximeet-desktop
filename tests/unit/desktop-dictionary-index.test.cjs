"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { INDEX_VERSION } = require("../../electron/services/text-dictionary-index.cjs");

// 使用实际随包 Core 公共索引核验查询计划；不拿小型内存表替代真实词库。
test("实际 Core 词典的精确词头批量查找使用覆盖索引，不扫描整库", () => {
  const db = new DatabaseSync(
    path.resolve(__dirname, "../../resources/dictionary/core-text.sqlite"),
    { readOnly: true },
  );
  try {
    const metadata = JSON.parse(
      db.prepare("SELECT payload FROM metadata WHERE id=1").get().payload,
    );
    assert.equal(metadata.indexVersion, INDEX_VERSION);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM entries").get().count, 117902);
    const statement = "SELECT id FROM entries WHERE headword=? ORDER BY id";
    const plan = db
      .prepare(`EXPLAIN QUERY PLAN ${statement}`)
      .all("system")
      .map((row) => row.detail)
      .join("\n");
    assert.match(plan, /SEARCH entries USING COVERING INDEX entries_exact/);
    assert.doesNotMatch(plan, /SCAN entries|USE TEMP B-TREE/);
    const query = db.prepare(statement);
    const words = db.prepare("SELECT headword FROM entries ORDER BY position LIMIT 100").all();
    for (const { headword } of words) assert.ok(query.all(headword).length > 0);
    assert.ok(query.all("system").length > 0);
    // 发布词库中原词头与查询键确实可能不同；优化不能丢失这些精确身份。
    for (const [headword, lookupKey] of [
      ["witneßes", "witnesses"],
      ["witneßing", "witnessing"],
    ]) {
      const exact = query.all(headword);
      assert.ok(exact.length > 0);
      const canonical = db
        .prepare("SELECT id FROM entries WHERE headword=? AND normalized=? ORDER BY id")
        .all(headword, lookupKey);
      assert.deepEqual(exact, canonical);
    }
    assert.deepEqual(query.all("leximeet-nonexistent-word-898234"), []);
  } finally {
    db.close();
  }
});

test("实际词性派生表来自压缩正文，查询有索引且保留多义项", () => {
  const { entryPartsOfSpeech } = require("../../electron/services/text-dictionary-index.cjs");
  assert.deepEqual(
    entryPartsOfSpeech({
      senses: [{ pos: "n." }, { pos: "v" }, { pos: "noun" }, { pos: "unknown" }],
    }),
    ["noun", "verb"],
  );
  const db = new DatabaseSync(
    path.resolve(__dirname, "../../resources/dictionary/core-text.sqlite"),
    { readOnly: true },
  );
  try {
    const row = db
      .prepare(
        "SELECT e.id,e.payload FROM entries e JOIN entry_parts_of_speech p ON p.entry_id=e.id WHERE p.pos=? LIMIT 1",
      )
      .get("noun");
    assert.ok(row);
    const source = JSON.parse(require("node:zlib").inflateRawSync(row.payload));
    assert.ok(entryPartsOfSpeech(source).includes("noun"));
    const plan = db
      .prepare("EXPLAIN QUERY PLAN SELECT entry_id FROM entry_parts_of_speech WHERE pos=?")
      .all("verb")
      .map((x) => x.detail)
      .join("\n");
    assert.match(plan, /entries_pos/);
    assert.doesNotMatch(plan, /SCAN/);
  } finally {
    db.close();
  }
});
