"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { contentInventory } = require("../../scripts/artifacts.cjs");

test("包内容清单按相对路径哈希，忽略清单自身并拒绝符号链接", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-inventory-"));
  try {
    fs.mkdirSync(path.join(root, "app"));
    fs.writeFileSync(path.join(root, "app", "note.txt"), "词遇");
    fs.writeFileSync(path.join(root, "SHA256SUMS"), "ignore\n");
    const first = contentInventory(root);
    const again = contentInventory(root);
    assert.equal(first.digest, again.digest);
    assert.equal(first.count, 1);
    assert.match(fs.readFileSync(path.join(root, "CONTENT-SHA256.txt"), "utf8"), /app\/note\.txt/);
    fs.symlinkSync(path.join(root, "app", "note.txt"), path.join(root, "link.txt"));
    assert.throws(() => contentInventory(root), /符号链接/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
