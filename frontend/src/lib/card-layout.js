/**
 * 词卡只编排已有事实，不在展示偏好里缓存释义、语境或复习状态。
 * 标识与 Core 的 CardLayoutSupport 保持一致；新增模块先实现真实内容和测试，再放入预设。
 */
export const CARD_MODULES = Object.freeze([
  { id: "pronunciation", name: "音标与状态", description: "展示音标和当前学习状态" },
  { id: "meaning", name: "简短释义", description: "每张词卡必备，不能隐藏" },
  { id: "collections", name: "单词本与标签", description: "展示个人整理关系" },
  { id: "evidence", name: "语境与详情", description: "查看当前语境、释义和历史记录" },
  { id: "note", name: "我的笔记", description: "保留个人理解与编辑入口" },
  { id: "encounterList", name: "全部遇见", description: "按时间查看每次真实遇见" },
  { id: "reviewSummary", name: "学习概览", description: "展示遇见和复习次数及最近学习时间" },
]);

export const CARD_LEVELS = Object.freeze([
  { id: "minimal", name: "极简", description: "只看词头与释义", sections: ["meaning"] },
  {
    id: "balanced",
    name: "适中",
    description: "适合日常阅读，默认推荐",
    sections: ["pronunciation", "meaning", "collections", "evidence", "note"],
  },
  {
    id: "rich",
    name: "完善",
    description: "补充全部遇见记录",
    sections: ["pronunciation", "meaning", "collections", "evidence", "note", "encounterList"],
  },
  {
    id: "complete",
    name: "全面",
    description: "查看目前可用的全部模块",
    sections: CARD_MODULES.map((item) => item.id),
  },
]);

export const defaultCardLayout = () => ({
  level: "balanced",
  mode: "preset",
  customSections: CARD_MODULES.map((item) => item.id),
  customSaved: false,
  revision: 0,
});

const supported = new Set(CARD_MODULES.map((item) => item.id));

// 词头、释义、语境各有固定阅读位置；只有记录栏的个人模块支持排序。
export const RECORD_CARD_SECTIONS = Object.freeze(["note", "collections", "reviewSummary"]);
export function moveRecordCardSection(sections, id, direction) {
  const ordered = sections.filter((section) => RECORD_CARD_SECTIONS.includes(section));
  const moved = moveCardSection(ordered, id, direction);
  let index = 0;
  return sections.map((section) =>
    RECORD_CARD_SECTIONS.includes(section) ? moved[index++] : section,
  );
}

export function visibleCardSections(layout) {
  const source =
    layout?.mode === "custom"
      ? layout.customSections
      : CARD_LEVELS.find((item) => item.id === layout?.level)?.sections || CARD_LEVELS[1].sections;
  if (!Array.isArray(source)) return [...CARD_LEVELS[1].sections];
  const sections = [...new Set(source.filter((id) => supported.has(id)))];
  return sections.includes("meaning") ? sections : [...CARD_LEVELS[1].sections];
}

export function moveCardSection(sections, id, direction) {
  const next = [...sections];
  const from = next.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= next.length) return next;
  [next[from], next[to]] = [next[to], next[from]];
  return next;
}

export function toggleCardSection(sections, id) {
  if (!supported.has(id) || id === "meaning") return [...sections];
  return sections.includes(id) ? sections.filter((item) => item !== id) : [...sections, id];
}
