import test from "node:test";
import assert from "node:assert/strict";
import {
  GUIDE_STEPS,
  currentGuideStep,
  placeGuide,
  highlightBounds,
} from "../src/desktop/guide-steps.js";

test("跳过后不伪造完成，续接定位到尚未完成的步骤", () => {
  const guide = {
    active: false,
    started: true,
    completed: ["sidebar", "goal", "plan"],
  };
  assert.equal(currentGuideStep(guide), null);
  assert.equal(
    currentGuideStep({ active: true, started: false, completed: [] }),
    null,
    "邀请期间没有操作教学",
  );
  assert.equal(currentGuideStep({ ...guide, active: true }).id, "learn");
  assert.equal(
    currentGuideStep({
      active: true,
      finishedAt: "done",
      completed: GUIDE_STEPS.map((s) => s.id),
    }),
    null,
  );
  assert.equal(new Set(GUIDE_STEPS.map((s) => s.id)).size, 13);
});
test("宽窗、窄窗及视口边缘的批注保持可见，并让实际控件可以点击", () => {
  for (const viewport of [
    { width: 1321, height: 864 },
    { width: 820, height: 600 },
  ]) {
    for (const anchor of [
      { left: 15, top: 126, right: 185, bottom: 161, width: 170, height: 35 },
      { left: 260, top: 285, right: 500, bottom: 330, width: 240, height: 45 },
      {
        left: viewport.width - 140,
        top: viewport.height - 108,
        right: viewport.width - 25,
        bottom: viewport.height - 70,
        width: 115,
        height: 38,
      },
    ]) {
      const box = placeGuide(anchor, viewport);
      assert.ok(box.x >= 14 && box.y >= 62);
      assert.ok(box.x + box.width <= viewport.width - 14);
      assert.ok(box.y + box.height <= viewport.height - 38);
      assert.ok(
        box.x >= anchor.right ||
          box.x + box.width <= anchor.left ||
          box.y >= anchor.bottom ||
          box.y + box.height <= anchor.top,
        "不能盖住教学目标",
      );
      assert.ok(Number.isFinite(box.end.x) && Number.isFinite(box.end.y));
    }
  }
});

test("整组选项及词头受保护，拖动位置保留，越界和遮挡自动避让", () => {
  const anchor = {
    left: 438,
    top: 456,
    right: 1088,
    bottom: 636,
    width: 650,
    height: 180,
  };
  const word = {
    left: 680,
    top: 390,
    right: 850,
    bottom: 440,
    width: 170,
    height: 50,
  };
  const viewport = { width: 1321, height: 864 };
  const free = (card, area) =>
    card.x >= area.right ||
    card.x + card.width <= area.left ||
    card.y >= area.bottom ||
    card.y + card.height <= area.top;
  for (const position of [undefined, { x: 40, y: 90 }, { x: 700, y: 450 }, { x: -200, y: 1000 }]) {
    const placed = placeGuide(
      anchor,
      viewport,
      { width: 340, height: 176 },
      { obstacles: [word], position },
    );
    assert.ok(free(placed, anchor) && free(placed, word));
    assert.ok(placed.x >= 14 && placed.x + placed.width <= viewport.width - 14);
    assert.ok(placed.y >= 62 && placed.y + placed.height <= viewport.height - 38);
    assert.ok(Number.isFinite(placed.start.x) && Number.isFinite(placed.end.y));
    if (position?.x === 40)
      assert.deepEqual({ x: placed.x, y: placed.y }, position, "用户移动到空位后不能弹回自动位置");
  }
});

test("发音连线沿词义外侧留白绕行，不穿过下方的阅读区", () => {
  const anchor = {
    left: 200,
    top: 190,
    right: 792,
    bottom: 224,
    width: 592,
    height: 34,
  };
  const meaning = {
    left: 200,
    top: 270,
    right: 792,
    bottom: 344,
    width: 592,
    height: 74,
  };
  const header = {
    left: 200,
    top: 100,
    right: 792,
    bottom: 160,
    width: 592,
    height: 60,
  };
  const placed = placeGuide(
    anchor,
    { width: 820, height: 600 },
    { width: 340, height: 170 },
    { obstacles: [header, meaning], position: { x: 14, y: 370 } },
  );
  const points = [...placed.path.matchAll(/[ML] ([\d.-]+) ([\d.-]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));
  assert.ok(points.length > 2, "直线会穿过词义，需沿空白转折");
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1],
      b = points[index];
    if (a.x === b.x)
      assert.ok(
        a.x < meaning.left ||
          a.x > meaning.right ||
          Math.max(a.y, b.y) <= meaning.top ||
          Math.min(a.y, b.y) >= meaning.bottom,
      );
    else {
      assert.equal(a.y, b.y);
      assert.ok(a.y <= meaning.top || a.y >= meaning.bottom);
    }
  }
  const end = points.at(-1);
  assert.ok(Math.abs(end.x - (anchor.left - 5)) < 1 || Math.abs(end.x - (anchor.right + 5)) < 1);
});

test("贴边容器的高亮与窗口标题和状态栏保持留白", () => {
  const box = highlightBounds(
    { left: 0, top: 48, right: 204, bottom: 872 },
    { width: 1321, height: 896 },
  );
  assert.deepEqual(box, {
    left: 9,
    top: 58,
    right: 209,
    bottom: 860,
    width: 200,
    height: 802,
  });
});
