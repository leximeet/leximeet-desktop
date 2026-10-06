"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const nav = (page, name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();

async function start(factory) {
  const desktop = await factory.start();
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await desktop.page.evaluate(async () => {
    const records = [
      [
        "resilient",
        "A resilient community learns from every challenge and grows stronger together.",
      ],
      [
        "coherent",
        "A coherent explanation connects each idea to the next, so the reader can follow the whole story.",
      ],
      [
        "context",
        "/workspace/reading-notes/english-study/reading-and-learning-context/long-reference-path/example-document.md",
      ],
    ];
    for (const [word, context] of records)
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context,
      });
    await window.leximeet.desktopCommand({
      action: "practiceRecord",
      wordId: "resilient",
      mode: "word-list",
      signal: "familiar",
      submissionId: crypto.randomUUID(),
    });
  });
  await desktop.page.reload();
  return desktop;
}

// 同一批隔离数据、窗口尺寸与主题用于改前 / 改后，截图不是生产资料。
test("词库与遇见记录的明暗宽窄视觉对照", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  const output = process.env.LEXIMEET_STATUS_CAPTURE || path.join(root, "test-results/word-status");
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, width, height] of [
    ["light", 1321, 896],
    ["dark", 820, 600],
  ]) {
    await resizeDesktop(desktop, width, height);
    if (theme === "dark")
      await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    for (const [name, file] of [
      ["我的词库", "library"],
      ["遇见记录", "encounters"],
    ]) {
      await nav(page, name);
      await expect(
        page.locator(file === "library" ? ".library-table tbody tr" : ".encounter-list li"),
      ).toHaveCount(3);
      await page.screenshot({
        path: path.join(output, `${file}-${theme}.png`),
        scale: "css",
        animations: "disabled",
      });
    }
  }
});

test("状态筛选覆盖真实 Core，支持搜索交集、键盘切换与空结果恢复", async ({ desktopFactory }) => {
  const { page } = await start(desktopFactory);
  await nav(page, "我的词库");
  const tabs = page.getByRole("tablist", { name: "单词状态" });
  const rows = page.locator(".library-table tbody tr");
  await expect(tabs.getByRole("tab", { name: "不熟悉", exact: true })).toHaveCount(1);
  await expect(tabs.getByRole("tab", { name: "生词", exact: true })).toHaveCount(0);
  await expect(rows).toHaveCount(3);
  await tabs.getByRole("tab", { name: "学习中", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("resilient");
  await expect(page.locator(".pagination")).toContainText("1–1 / 1");
  await tabs.getByRole("tab", { name: "学习中", exact: true }).press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "待复习", exact: true })).toBeFocused();
  await expect(rows).toHaveCount(0); // 新词不再冒充待复习。
  await tabs.getByRole("tab", { name: "未学习", exact: true }).click();
  await expect(rows).toHaveCount(2);
  await page.getByRole("textbox", { name: "搜索单词", exact: true }).fill("resilient");
  await expect(page.getByRole("heading", { name: "没有匹配的单词", exact: true })).toBeVisible();
  await expect(page.locator(".d-word-card")).toHaveCount(0);
  await page.getByRole("button", { name: "查看全部单词", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("textbox", { name: "搜索单词", exact: true })).toHaveValue(
    "resilient",
  );
  await page.getByRole("button", { name: "清空搜索", exact: true }).first().click();
  await expect(rows).toHaveCount(3);
  await tabs.getByRole("tab", { name: "已熟悉", exact: true }).click();
  await expect(page.getByRole("heading", { name: "暂无这类单词", exact: true })).toBeVisible();
  await expect(page.locator(".d-word-card")).toHaveCount(0);
  // 回收站在侧栏底部，位于主导航分组之外。
  await page.getByRole("button", { name: "回收站", exact: true }).click();
  await expect(tabs).toHaveCount(0);
  await nav(page, "我的词库");
  await expect(tabs.getByRole("tab", { name: "全部", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(rows).toHaveCount(3);
});

test("遇见语境小于单词，安全高亮且长路径在窄窗口内换行", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  await nav(page, "遇见记录");
  await expect(page.locator(".encounter-list li")).toHaveCount(3);
  await expect(
    page.locator(".encounter-list li").filter({ hasText: "A resilient" }).locator("mark"),
  ).toHaveText("resilient");
  for (const width of [1321, 820]) {
    await resizeDesktop(desktop, width, 896);
    const measurements = await page.locator(".encounter-list li").evaluateAll((items) =>
      items.map((item) => {
        const word = item.querySelector(".encounter-word"),
          context = item.querySelector(".encounter-context");
        return {
          word: parseFloat(getComputedStyle(word).fontSize),
          context: parseFloat(getComputedStyle(context).fontSize),
          width: item.clientWidth,
          scroll: item.scrollWidth,
        };
      }),
    );
    for (const item of measurements) {
      expect(item.word).toBeGreaterThan(item.context);
      expect(item.scroll).toBeLessThanOrEqual(item.width + 1);
    }
  }
});
