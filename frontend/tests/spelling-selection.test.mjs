import test from "node:test";
import assert from "node:assert/strict";
import { createSpellingSelection } from "../src/desktop/spelling-selection.js";

function input(value, start = value.length, end = start, direction = "none") {
  return {
    value,
    disabled: false,
    selectionStart: start,
    selectionEnd: end,
    selectionDirection: direction,
    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
    },
  };
}

test("提示或主题切换后原生聚焦把光标复位，仍恢复真实插入点并支持退格", () => {
  const selection = createSpellingSelection();
  const field = input("el");
  selection.remember(field);
  // 模拟浏览器失焦后重新 focus，把原生光标置于开头；视觉层不能仅记住旧位置。
  field.selectionStart = field.selectionEnd = 0;
  assert.equal(selection.restore(field), 2);
  const before = field.value.slice(0, field.selectionStart - 1);
  field.value = before + field.value.slice(field.selectionEnd);
  field.selectionStart = field.selectionEnd = before.length;
  selection.remember(field);
  assert.equal(field.value, "e");
  assert.equal(selection.restore(field), 1);
});

test("用户选中中间文字后暂时禁用，不用禁用造成的空选区覆盖原选区和方向", () => {
  const selection = createSpellingSelection();
  const field = input("elephant", 2, 5, "backward");
  selection.remember(field);
  field.disabled = true;
  field.selectionStart = field.selectionEnd = 0;
  assert.equal(selection.remember(field), undefined);
  field.disabled = false;
  selection.restore(field);
  assert.equal(field.selectionStart, 2);
  assert.equal(field.selectionEnd, 5);
  assert.equal(field.selectionDirection, "backward");
});

test("切换题目和恢复另一份输入草稿从末端继续，空草稿不残留上一词位置", () => {
  const selection = createSpellingSelection();
  const field = input("elephant", 3);
  selection.remember(field);
  field.value = "ba";
  assert.equal(selection.restore(field), 2);
  field.value = "";
  assert.equal(selection.restore(field), 0);
});
