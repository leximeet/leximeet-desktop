// 教学说明与业务分开：真实操作等待成功回执，参观只确认阅读，不创建假资料。
export const DEFAULT_GUIDE_GOAL = "book:qwerty:IELTS_3_T";
export const GUIDE_STEPS = [
  {
    id: "sidebar",
    title: "先认识侧边栏",
    text: "上方学习，下方管理词库。设置和回收站在底部。",
    page: "today",
    anchor: "sidebar",
    read: true,
  },
  {
    id: "goal",
    title: "选择学习目标",
    text: "默认雅思，可换一个目标，也可以暂不设置。",
    page: "plan",
    anchor: "guide-goal-choice",
    optional: true,
  },
  {
    id: "plan",
    title: "安排学习节奏",
    text: "设定每天新学、复习和提醒范围，也可以暂不安排。",
    page: "plan",
    anchor: "plan-form",
    optional: true,
  },
  {
    id: "learn",
    title: "回想一个单词",
    text: "中文默认遮住。回想后选择“熟练 +1”或“不熟悉 −1”。",
    page: "practice",
    anchor: "practice-list",
  },
  {
    id: "audio",
    title: "听单词发音",
    text: "点击美式或英式，播完后继续。",
    page: "library",
    anchor: "word-audio",
  },
  {
    id: "practice",
    title: "试一次单词临摹",
    text: "照着单词逐字输入。默写和选义等方式会检验回忆。",
    page: "practice",
    anchor: "practice-input",
  },
  {
    id: "clipboard",
    title: "复制句子，遇见单词",
    text: "复制文本时，只提醒当前目标中的词，并保留原文语境。没有目标时不提醒。",
    page: "settings",
    anchor: "clipboard-preview",
    read: true,
    interactive: true,
  },
  {
    id: "trash",
    title: "认识回收站",
    text: "点击回收站，看看恢复资料的位置。",
    page: "library",
    anchor: "nav-trash",
    read: true,
    visit: "trash",
  },
  {
    id: "dictionary",
    title: "浏览词库中心",
    text: "这里管理考试、学科词库和本地词典。",
    page: "dictionary",
    anchor: "dictionary-resource",
    read: true,
  },
  {
    id: "insights",
    title: "查看学习洞察",
    text: "这里汇总真实学习和练习记录。",
    page: "insights",
    anchor: "insights-stats",
    read: true,
  },
  {
    id: "theme",
    title: "认识外观设置",
    text: "主题和词卡都在这里调整。",
    page: "settings",
    anchor: "appearance-preview",
    read: true,
  },
  {
    id: "audioSettings",
    title: "认识发音设置",
    text: "可选择有道、微软或自定义 API。",
    page: "settings",
    anchor: "audio-preview",
    read: true,
  },
  {
    id: "captureSettings",
    title: "随时记录一次遇见",
    text: "遇见采集快捷键打开独立窗口，草稿可稍后继续。",
    page: "settings",
    anchor: "capture-preview-settings",
    read: true,
    interactive: true,
  },
];

export function currentGuideStep(guide) {
  return guide?.active && guide.started && !guide.finishedAt
    ? GUIDE_STEPS[guide.cursor ?? guide.completed?.length ?? 0]
    : null;
}

// 箭头从卡片边缘连接到高亮边缘；拖动后仍使用当前位置计算。
function edge(rect, towards, padding = 0) {
  const center = {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
  };
  const dx = towards.x - center.x || (towards.y === center.y ? 1 : 0);
  const dy = towards.y - center.y;
  const ratio = Math.min(
    dx ? (rect.width / 2 + padding) / Math.abs(dx) : Infinity,
    dy ? (rect.height / 2 + padding) / Math.abs(dy) : Infinity,
  );
  return { x: center.x + dx * ratio, y: center.y + dy * ratio };
}

// 用线段裁剪检查文字区域；只有实际穿入内部才需要绕行。
function crosses(from, to, area) {
  let enter = 0,
    leave = 1;
  for (const [start, delta, min, max] of [
    [from.x, to.x - from.x, area.left - 2, area.right + 2],
    [from.y, to.y - from.y, area.top - 2, area.bottom + 2],
  ]) {
    if (!delta) {
      if (start < min || start > max) return false;
    } else {
      const a = (min - start) / delta,
        b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
  }
  return enter < 1 && leave > 0;
}

// 直线穿过阅读文字时，沿内容左右留白绕行，仍指向实际高亮控件边缘。
function connectorPath(start, end, anchor, card, viewport, areas) {
  const path = (points) =>
    points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ");
  if (!areas.some((area) => crosses(start, end, area))) return path([start, end]);
  const channels = [...areas, anchor].flatMap((area) => [area.left - 12, area.right + 12]);
  const routes = [];
  for (const x of channels) {
    if (x < 14 || x > viewport.width - 14 || (x >= anchor.left && x <= anchor.right)) continue;
    const endPoint = {
      x: x < anchor.left ? anchor.left - 5 : anchor.right + 5,
      y: anchor.top + anchor.height / 2,
    };
    const startPoint =
      x >= card.left && x <= card.left + card.width
        ? { x, y: endPoint.y < card.top ? card.top : card.top + card.height }
        : {
            x: x < card.left ? card.left : card.left + card.width,
            y: Math.max(card.top + 12, Math.min(card.top + card.height - 12, endPoint.y)),
          };
    const points = [startPoint, { x, y: startPoint.y }, { x, y: endPoint.y }, endPoint];
    if (
      points
        .slice(1)
        .some((point, index) => areas.some((area) => crosses(points[index], point, area)))
    )
      continue;
    const length = points
      .slice(1)
      .reduce(
        (sum, point, index) =>
          sum + Math.hypot(point.x - points[index].x, point.y - points[index].y),
        0,
      );
    routes.push({ points, length });
  }
  routes.sort((a, b) => a.length - b.length);
  return path(routes[0]?.points || [start, end]);
}

/**
 * 同时避开整组操作和题目内容；不能只保护第一个答案。
 * 手动位置优先，越界时收回窗口内，遇到操作区域时选最近的空位。
 */
export function placeGuide(anchor, viewport, card = { width: 340, height: 176 }, options = {}) {
  const gap = viewport.width <= 860 ? 18 : 24;
  const padding = 14,
    top = 62,
    bottom = viewport.height - 38;
  const width = Math.min(card.width, viewport.width - padding * 2);
  const height = Math.min(card.height, bottom - top);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const protectedAreas = [anchor, ...(options.obstacles || [])];
  const centeredX = anchor.left + anchor.width / 2 - width / 2;
  const centeredY = anchor.top + anchor.height / 2 - height / 2;
  const candidates = [
    ...(options.position ? [options.position] : []),
    { x: anchor.right + gap, y: centeredY },
    { x: centeredX, y: anchor.bottom + gap },
    { x: anchor.left - width - gap, y: centeredY },
    { x: centeredX, y: anchor.top - height - gap },
  ];
  // 上下居中往往压住题干；把边缘对齐和视口角落也纳入候选。
  const xs = [
    padding,
    viewport.width - width - padding,
    ...protectedAreas.flatMap((area) => [
      area.left,
      area.right - width,
      area.left - width - gap,
      area.right + gap,
    ]),
  ];
  const ys = [
    top,
    bottom - height,
    ...protectedAreas.flatMap((area) => [area.top - height - gap, area.bottom + gap]),
  ];
  for (const x of xs) for (const y of ys) candidates.push({ x, y });
  const desired = options.position || candidates[0];
  const chosen = candidates
    .map((candidate, priority) => {
      const x = clamp(candidate.x, padding, viewport.width - width - padding);
      const y = clamp(candidate.y, top, bottom - height);
      const overlap = protectedAreas.reduce(
        (sum, area) =>
          sum +
          Math.max(0, Math.min(x + width, area.right + 8) - Math.max(x, area.left - 8)) *
            Math.max(0, Math.min(y + height, area.bottom + 8) - Math.max(y, area.top - 8)),
        0,
      );
      const distance = options.position
        ? Math.hypot(x - desired.x, y - desired.y)
        : Math.hypot(x - centeredX, y - centeredY) * 0.15;
      return {
        x,
        y,
        width,
        height,
        score: overlap * 100000 + distance + priority,
      };
    })
    .sort((a, b) => a.score - b.score)[0];
  const cardRect = { left: chosen.x, top: chosen.y, width, height };
  const center = {
    x: anchor.left + anchor.width / 2,
    y: anchor.top + anchor.height / 2,
  };
  const cardCenter = { x: chosen.x + width / 2, y: chosen.y + height / 2 };
  // 箭头连接最近的边缘投影，避免为了指向选项中心而穿过上方词头。
  let start, end;
  if (chosen.y + height <= anchor.top || chosen.y >= anchor.bottom) {
    const below = chosen.y >= anchor.bottom;
    end = {
      x: clamp(cardCenter.x, anchor.left + 12, anchor.right - 12),
      y: below ? anchor.bottom + 5 : anchor.top - 5,
    };
    start = {
      x: clamp(end.x, chosen.x + 12, chosen.x + width - 12),
      y: below ? chosen.y : chosen.y + height,
    };
  } else if (chosen.x + width <= anchor.left || chosen.x >= anchor.right) {
    const right = chosen.x >= anchor.right;
    end = {
      x: right ? anchor.right + 5 : anchor.left - 5,
      y: clamp(cardCenter.y, anchor.top + 12, anchor.bottom - 12),
    };
    start = {
      x: right ? chosen.x : chosen.x + width,
      y: clamp(end.y, chosen.y + 12, chosen.y + height - 12),
    };
  } else {
    start = edge(cardRect, center);
    end = edge(anchor, cardCenter, 5);
  }
  return {
    ...chosen,
    start,
    end,
    path: connectorPath(
      start,
      end,
      anchor,
      cardRect,
      viewport,
      options.connectorObstacles || options.obstacles || [],
    ),
  };
}

// 高亮在应用内容边界内留白，侧边栏等贴边容器也不会描到窗口外。
export function highlightBounds(rect, viewport) {
  const left = Math.max(9, rect.left - 5),
    top = Math.max(58, rect.top - 5);
  const right = Math.min(viewport.width - 9, rect.right + 5);
  const bottom = Math.min(viewport.height - 36, rect.bottom + 5);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}
