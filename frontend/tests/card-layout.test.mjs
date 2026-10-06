import test from "node:test";
import assert from "node:assert/strict";
import {
  CARD_LEVELS,
  CARD_MODULES,
  defaultCardLayout,
  moveCardSection,
  moveRecordCardSection,
  toggleCardSection,
  visibleCardSections,
} from "../src/lib/card-layout.js";

test("默认适中且四档展示递进，词头固定不进入可隐藏模块", () => {
  assert.equal(defaultCardLayout().level, "balanced");
  assert.equal(defaultCardLayout().customSaved, false);
  assert.deepEqual(
    CARD_LEVELS.map((item) => item.name),
    ["极简", "适中", "完善", "全面"],
  );
  assert.deepEqual(visibleCardSections(defaultCardLayout()), CARD_LEVELS[1].sections);
  assert.deepEqual(CARD_LEVELS[0].sections, ["meaning"]);
  assert.equal(CARD_LEVELS.at(-1).sections.length, CARD_MODULES.length);
  assert.ok(CARD_LEVELS.every((level) => level.sections.includes("meaning")));
});

test("自定义只编排模块 ID，隐藏、上移与重新加入不修改词条内容", () => {
  const base = ["pronunciation", "meaning", "note"];
  assert.deepEqual(moveCardSection(base, "note", -1), ["pronunciation", "note", "meaning"]);
  assert.deepEqual(toggleCardSection(base, "note"), ["pronunciation", "meaning"]);
  assert.deepEqual(toggleCardSection(base, "meaning"), base);
  assert.deepEqual(toggleCardSection(["meaning"], "note"), ["meaning", "note"]);
  assert.deepEqual(base, ["pronunciation", "meaning", "note"]);
  assert.deepEqual(visibleCardSections({ mode: "custom", customSections: ["note", "meaning"] }), [
    "note",
    "meaning",
  ]);
  assert.deepEqual(
    visibleCardSections({ mode: "custom", customSections: ["unknown"] }),
    CARD_LEVELS[1].sections,
  );
});

test("记录模块的排序跨过固定阅读区域，不移动词头、释义与语境", () => {
  const base = ["pronunciation", "meaning", "collections", "evidence", "note", "reviewSummary"];
  assert.deepEqual(moveRecordCardSection(base, "note", -1), [
    "pronunciation",
    "meaning",
    "note",
    "evidence",
    "collections",
    "reviewSummary",
  ]);
  assert.deepEqual(moveRecordCardSection(base, "collections", -1), base);
  assert.deepEqual(moveRecordCardSection(base, "meaning", 1), base);
  assert.deepEqual(base, [
    "pronunciation",
    "meaning",
    "collections",
    "evidence",
    "note",
    "reviewSummary",
  ]);
});
