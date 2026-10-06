/**
 * 隐形输入与视觉字母共用真实选区。提示保存、主题按钮或短暂禁用会令输入失焦，
 * 再聚焦时恢复用户原来的插入点/选区；换词后的新草稿默认从末端继续。
 */
export function createSpellingSelection() {
  let saved = null;
  const bound = (position, value) =>
    Math.max(0, Math.min(value.length, Number.isInteger(position) ? position : value.length));
  function remember(field) {
    if (!field || field.disabled) return;
    const value = field.value || "";
    saved = {
      value,
      start: bound(field.selectionStart, value),
      end: bound(field.selectionEnd, value),
      direction: field.selectionDirection || "none",
    };
    return saved.start;
  }
  function restore(field) {
    if (!field || field.disabled) return;
    const value = field.value || "";
    if (!saved || saved.value !== value)
      saved = { value, start: value.length, end: value.length, direction: "none" };
    field.setSelectionRange(saved.start, saved.end, saved.direction);
    return saved.start;
  }
  return { remember, restore };
}
