"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");
const nav = (page, name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
async function start(factory) {
  const desktop = await factory.start();
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(desktop.page.locator(".guide-invitation-card")).toHaveCount(0);
  return desktop;
}
async function seed(page) {
  await page.evaluate(async () => {
    for (const word of ["coherent", "resilient", "serendipity"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `A ${word} example makes the idea clear.`,
      });
  });
  await page.reload();
  await nav(page, "我的词库");
  await expect(page.locator(".library-table tbody tr")).toHaveCount(3);
}

test("阅读与编辑分开，空搜索不能编辑旧词，单词切换与收起词卡仍保留草稿", async ({
  desktopFactory,
}) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  await seed(page);
  await page.getByRole("row").filter({ hasText: "serendipity" }).click();
  await expect(page.getByRole("heading", { name: "serendipity", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "我的笔记" })).toHaveCount(0);
  await page.getByRole("tab", { name: "语境", exact: false }).click();
  await expect(page.locator(".context-entry mark")).toHaveText("serendipity");
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await page.getByRole("textbox", { name: "我的笔记" }).fill("搜索与切页不能丢掉这段草稿");
  const search = page.getByRole("textbox", { name: "搜索单词", exact: true });
  await search.fill("missing-no-such-word");
  await expect(page.getByRole("heading", { name: "没有匹配的单词", exact: true })).toBeVisible();
  await expect(page.locator(".d-word-card")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存笔记与归类" })).toHaveCount(0);
  await page.getByRole("button", { name: "清空搜索", exact: true }).first().click();
  await expect(page.locator(".library-table tbody tr")).toHaveCount(3);
  await page.getByRole("row").filter({ hasText: "serendipity" }).click();
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "我的笔记" })).toHaveValue(
    "搜索与切页不能丢掉这段草稿",
  );
  await page.getByRole("button", { name: "关闭词卡", exact: true }).click();
  await expect(page.locator(".d-detail-column")).toBeHidden();
  await page.getByRole("button", { name: "展开词卡", exact: true }).click();
  await page.getByRole("button", { name: "保存笔记与归类", exact: true }).click();
  await expect(page.getByText("草稿未保存", { exact: true })).toHaveCount(0);
  const detail = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "serendipity" }),
  );
  expect(detail.note).toBe("搜索与切页不能丢掉这段草稿");
  expect(desktop.pageErrors).toEqual([]);
});

test("列表指定行反馈不改变临摹游标，关闭自动继续后熟记为手动继续，快速双击不会跳过词条", async ({
  desktopFactory,
}) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  await seed(page);
  await nav(page, "练习中心");
  const rows = page.locator(".practice-list-table tbody tr");
  await expect(rows).toHaveCount(3);
  await rows.nth(1).getByRole("button", { name: "熟练 +1", exact: true }).click();
  await expect(rows.nth(1).locator(".signal-count")).toContainText("1 熟");
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  await page.getByRole("button", { name: "练习设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "自动进入下一词" }).uncheck();
  await expect(page.locator(".practice-headword")).toHaveText("coherent");
  await page.getByRole("textbox", { name: "练习答案" }).fill("coherent");
  await expect(page.getByRole("button", { name: "熟记", exact: true })).toBeVisible();
  await expect(page.locator(".practice-headword")).toHaveText("coherent");
  await page.getByRole("button", { name: "熟记", exact: true }).dblclick();
  await expect(page.locator(".practice-headword")).toHaveText("resilient");
  expect(desktop.pageErrors).toEqual([]);
});

test("创建分类对话框圈定焦点，Escape 退出且不创建资料；设置草稿跨主页面保留", async ({
  desktopFactory,
}) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  const before = await page.evaluate(() => window.leximeet.desktopState());
  await page.getByRole("button", { name: "创建单词本", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "创建单词本", exact: true });
  await expect(dialog).toBeVisible();
  await expect(page.getByRole("textbox", { name: "单词本名称" })).toBeFocused();
  await page.getByRole("textbox", { name: "单词本名称" }).fill("未提交的分类");
  await page.keyboard.press((process.platform === "darwin" ? "Meta" : "Control") + "+3");
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  expect((await page.evaluate(() => window.leximeet.desktopState())).books.length).toBe(
    before.books.length,
  );
  await page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "发音", exact: true })
    .click();
  await page.getByRole("combobox", { name: "发音提供者" }).selectOption("custom");
  await page
    .getByRole("textbox", { name: "自定义 API 地址" })
    .fill("https://example.test/audio?word={word}");
  await nav(page, "今日学习");
  await page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "自定义 API 地址" })).toHaveValue(
    "https://example.test/audio?word={word}",
  );
  expect(desktop.pageErrors).toEqual([]);
});

test("词卡按需展开真实遇见，记录模块自定义排序实际生效", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  await seed(page);
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "serendipity",
      context: "Another serendipity moment is worth remembering.",
    }),
  );
  await page.reload();
  await nav(page, "我的词库");
  await page.getByRole("row").filter({ hasText: "serendipity" }).click();
  await expect(page.locator(".context-entry")).toHaveCount(1);
  await page.getByRole("button", { name: "查看全部 2 条遇见", exact: true }).click();
  await expect(page.locator(".context-entry")).toHaveCount(2);
  await page.getByRole("button", { name: "只看最近语境", exact: true }).click();
  await expect(page.locator(".context-entry")).toHaveCount(1);
  await page.locator('[data-guide="nav-settings"]').click();
  await page.getByRole("button", { name: "自定义词卡面板", exact: true }).click();
  await expect(page.getByRole("button", { name: "上移简短释义", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "上移我的笔记", exact: true }).click();
  await page.getByRole("button", { name: "保存词卡排布", exact: true }).click();
  await expect(page.getByRole("region", { name: "自定义词卡面板", exact: true })).toHaveCount(0);
  await nav(page, "我的词库");
  await page.getByRole("tab", { name: "记录", exact: true }).click();
  await expect(page.locator(".record-reading [data-card-module]")).toHaveCount(2);
  expect(
    await page
      .locator(".record-reading [data-card-module]")
      .evaluateAll((nodes) => nodes.map((n) => n.dataset.cardModule)),
  ).toEqual(["note", "collections"]);
  expect(desktop.pageErrors).toEqual([]);
});
