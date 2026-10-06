"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const nav = (page, name) =>
  page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
const query = (page, request) =>
  page.evaluate((value) => window.leximeet.desktopQuery(value), request);
// 回收站的可访问名称包含实时数量（例如“回收站 3”），入口仍是侧边栏真实按钮。
const openTrash = (page) =>
  page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: /^回收站(?:\s+\d+)?$/ })
    .click();

async function start(factory) {
  const desktop = await factory.start();
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  return desktop;
}

async function seed(page) {
  const result = await page.evaluate(async () => {
    const run = (value) => window.leximeet.desktopCommand(value);
    // 使用专用词本名，避免与初始化的“技术阅读”等默认词本重名。
    for (const name of ["批量技术词本", "批量日常词本", "批量原有词本"])
      await run({ action: "createBook", name });
    const snapshot = await window.leximeet.desktopState();
    const books = Object.fromEntries(snapshot.books.map((book) => [book.name, book.id]));
    await run({
      action: "capture",
      word: "coherent",
      context: "A coherent explanation helps us understand the design.",
      bookIds: [books["批量原有词本"]],
    });
    await run({
      action: "capture",
      word: "resilient",
      context: "A resilient community keeps learning together.",
    });
    await run({
      action: "collect",
      word: "leximeet-personal-example",
      note: "原笔记",
    });
    return { books };
  });
  await page.reload();
  await nav(page, "我的词库");
  await expect(page.locator(".library-table tbody tr")).toHaveCount(3);
  return result;
}

test("当前页全选、多词本追加与批量回收恢复，确认前不修改资料", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  const { books } = await seed(page);
  const card = page.locator(".d-word-card");
  await card.getByRole("button", { name: "移到回收站", exact: true }).click();
  const trashDialog = page.getByRole("dialog", { name: "移到回收站？", exact: true });
  await expect(trashDialog).toBeVisible();
  expect((await query(page, { scope: "library" })).total).toBe(3);
  await trashDialog.getByRole("button", { name: "取消", exact: true }).click();
  expect((await query(page, { scope: "library" })).total).toBe(3);

  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  const bulk = page.getByRole("group", { name: "单词批量操作", exact: true });
  await expect(bulk).toContainText("已选 3 词");
  await bulk.getByRole("button", { name: "放入单词本", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "放入单词本", exact: true });
  await expect(picker.getByRole("button", { name: "确认放入", exact: true })).toBeDisabled();
  await picker.getByRole("checkbox", { name: "放入单词本 批量技术词本", exact: true }).check();
  await picker.getByRole("checkbox", { name: "放入单词本 批量日常词本", exact: true }).check();
  await picker.getByRole("button", { name: "确认放入", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(bulk).toContainText("已选 0 词");
  for (const wordId of ["coherent", "resilient", "leximeet-personal-example"]) {
    const detail = await query(page, { kind: "detail", wordId });
    const ids = detail.books.map((book) => book.id);
    expect(ids).toEqual(expect.arrayContaining([books["批量技术词本"], books["批量日常词本"]]));
    if (wordId === "coherent") expect(ids).toContain(books["批量原有词本"]);
  }

  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await bulk.getByRole("button", { name: "移到回收站", exact: true }).click();
  await expect(trashDialog).toContainText("3 个单词");
  await trashDialog.getByRole("button", { name: "确认移到回收站", exact: true }).click();
  await expect(trashDialog).toHaveCount(0);
  await expect(page.locator(".library-table tbody tr")).toHaveCount(0);
  await openTrash(page);
  await expect(page.locator(".library-table tbody tr")).toHaveCount(3);
  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await bulk.getByRole("button", { name: "恢复所选", exact: true }).click();
  await expect(page.locator(".library-table tbody tr")).toHaveCount(0);
  await nav(page, "我的词库");
  await expect(page.locator(".library-table tbody tr")).toHaveCount(3);
  expect((await query(page, { kind: "detail", wordId: "leximeet-personal-example" })).note).toBe(
    "原笔记",
  );
  expect(desktop.pageErrors).toEqual([]);
});

test("个人内容仅笔记与多选词本，保存后保留完整词本归属", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  const { books } = await seed(page);
  await page.getByRole("row").filter({ hasText: "leximeet-personal-example" }).click();
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "自定义释义" })).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: /关联标签/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "创建标签", exact: true })).toHaveCount(0);
  await expect(page.locator(".tag-navigation")).toHaveCount(0);
  await page.getByRole("textbox", { name: "我的笔记", exact: true }).fill("自己的理解只写在笔记里");
  await page.getByRole("checkbox", { name: "关联单词本 批量技术词本", exact: true }).check();
  await page.getByRole("checkbox", { name: "关联单词本 批量日常词本", exact: true }).check();
  await page.getByRole("button", { name: "保存笔记与归类", exact: true }).click();
  await expect(page.getByText("草稿未保存", { exact: true })).toHaveCount(0);
  const detail = await query(page, { kind: "detail", wordId: "leximeet-personal-example" });
  expect(detail.note).toBe("自己的理解只写在笔记里");
  expect(detail.books.map((book) => book.id).sort()).toEqual(
    [books["批量技术词本"], books["批量日常词本"]].sort(),
  );
  expect(desktop.pageErrors).toEqual([]);
});

test("目标词只引用入库，单词可见回收与恢复；排序词性筛选不保留旧勾选", async ({
  desktopFactory,
}) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  const initial = await page.evaluate(async () => {
    const state = await window.leximeet.desktopState();
    const goal = state.catalogs.find((item) => /雅思/.test(item.title_zh)).catalog_id;
    await window.leximeet.desktopCommand({
      action: "setGoal",
      goal,
      expectedRevision: state.profile.revision,
    });
    const words = await window.leximeet.desktopQuery({
      kind: "words",
      scope: "library",
      limit: 40,
    });
    return { goal, total: words.total, word: words.words[0] };
  });
  await page.reload();
  await nav(page, "我的词库");
  await expect(page.getByRole("combobox", { name: "词库排序", exact: true })).toHaveValue("recent");
  expect(initial.total).toBeGreaterThan(100);
  const before = await query(page, { kind: "detail", wordId: initial.word.id });
  expect(before.manualActive).toBe(false);
  await page.getByRole("textbox", { name: "搜索单词", exact: true }).fill(initial.word.word);
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: initial.word.word, exact: true }) })
    .click();
  await page
    .locator(".d-word-card")
    .getByRole("button", { name: "移到回收站", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "移到回收站？", exact: true })
    .getByRole("button", { name: "确认移到回收站", exact: true })
    .click();
  await openTrash(page);
  await expect(page.locator(".library-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "恢复这个词条", exact: true }).click();
  await expect(page.locator(".library-table tbody tr")).toHaveCount(0);
  const restored = await query(page, { kind: "detail", wordId: initial.word.id });
  expect(restored.manualActive).toBe(false);
  expect(restored.encounters).toHaveLength(0);
  await nav(page, "我的词库");
  expect((await query(page, { kind: "words", scope: "library" })).total).toBe(initial.total);
  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await expect(page.getByRole("group", { name: "单词批量操作" })).toContainText("已选 40 词");
  await page.getByRole("combobox", { name: "词库排序", exact: true }).selectOption("alphabetical");
  await expect(page.getByRole("group", { name: "单词批量操作" })).toContainText("已选 0 词");
  await page.getByRole("combobox", { name: "筛选词性", exact: true }).selectOption("noun");
  const filtered = await query(page, {
    kind: "words",
    scope: "library",
    sort: "alphabetical",
    partOfSpeech: "noun",
    limit: 40,
  });
  expect(filtered.words.length).toBeGreaterThan(0);
  expect(filtered.words.every((word) => word.partsOfSpeech.includes("noun"))).toBe(true);
  await expect(page.locator(".library-table tbody tr")).toHaveCount(filtered.words.length);
  expect(await page.locator(".library-table .word-column").allTextContents()).toEqual(
    filtered.words.map((word) => word.word),
  );
  await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
  await page.getByRole("button", { name: "下一页", exact: true }).click();
  await expect(page.getByRole("group", { name: "单词批量操作" })).toContainText("已选 0 词");
  expect(desktop.pageErrors).toEqual([]);
});

test("词库多选在明暗主题和窄窗中无横向溢出，词本选择与回收确认可见", async ({ desktopFactory }) => {
  const desktop = await start(desktopFactory),
    page = desktop.page;
  await seed(page);
  const output =
    process.env.LEXIMEET_USABILITY_CAPTURE ||
    path.join(root, "test-results/desktop-usability/after");
  fs.mkdirSync(output, { recursive: true });
  const bulk = page.getByRole("group", { name: "单词批量操作", exact: true });
  async function capture(name) {
    // 检查主窗口和控件本身；局部滚动不能掩盖整页被撑宽的问题。
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
      ),
    ).toBe(true);
    for (const selector of [".d-library", ".library-query-controls", ".list-card-split"])
      expect(
        await page.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
    const dialog = page.getByRole("dialog");
    if (await dialog.count())
      expect(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({
      path: path.join(output, name),
      scale: "css",
      animations: "disabled",
    });
  }
  for (const [theme, width, height, name] of [
    ["light", 1321, 896, "library-light.png"],
    ["dark", 1321, 896, "library-dark.png"],
    ["dark", 820, 728, "library-narrow.png"],
  ]) {
    await page.evaluate((theme) => window.leximeet.settings({ theme }), theme);
    await page.reload();
    await resizeDesktop(desktop, width, height);
    await nav(page, "我的词库");
    await page.getByRole("checkbox", { name: "选择当前页全部单词", exact: true }).check();
    await expect(bulk).toContainText("已选 3 词");
    await capture(name);
  }
  await bulk.getByRole("button", { name: "放入单词本", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "放入单词本", exact: true });
  await picker.getByRole("checkbox", { name: "放入单词本 批量技术词本", exact: true }).check();
  await picker.getByRole("checkbox", { name: "放入单词本 批量日常词本", exact: true }).check();
  await capture("library-books-narrow.png");
  await picker.getByRole("button", { name: "取消", exact: true }).click();
  await bulk.getByRole("button", { name: "移到回收站", exact: true }).click();
  const confirmation = page.getByRole("dialog", { name: "移到回收站？", exact: true });
  await expect(confirmation).toContainText("3 个单词");
  await capture("library-trash-confirm.png");
  await confirmation.getByRole("button", { name: "取消", exact: true }).click();
  expect((await query(page, { kind: "words", scope: "library" })).total).toBe(3);
  expect(desktop.pageErrors).toEqual([]);
});
