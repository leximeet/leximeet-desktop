"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");

// 文档截图走用户真实入口；资料、窗口和输入全部由隔离 fixture 管理。
test("使用演示：手动记录后编辑笔记和多个单词本，完整窗口明暗截图", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  const output = process.env.LEXIMEET_DOCS_CAPTURE || path.join(root, "test-results/docs-demo");
  fs.mkdirSync(output, { recursive: true });
  await resizeDesktop(desktop, 1321, 1040);
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();

  // 创建和采集都使用真实可访问控件，不向数据库注入展示资料。
  for (const name of ["演示阅读", "复习摘录"]) {
    await page.getByRole("button", { name: "创建单词本", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "创建单词本", exact: true });
    await dialog.getByRole("textbox", { name: "单词本名称", exact: true }).fill(name);
    await dialog.getByRole("button", { name: "创建", exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "遇见记录", exact: true })
    .click();
  await page.getByRole("button", { name: "记录新的遇见", exact: true }).click();
  await expect
    .poll(() => desktop.app.windows().some((item) => item.url().endsWith("#capture-editor")))
    .toBe(true);
  const capture = desktop.app.windows().find((item) => item.url().endsWith("#capture-editor"));
  await capture.getByRole("textbox", { name: "捕获单词", exact: true }).fill("node");
  await capture
    .getByRole("textbox", { name: "捕获语境", exact: true })
    .fill("Node connects a useful idea to another idea.");
  await capture.getByRole("button", { name: "确认保存遇见", exact: true }).click();
  await expect(page.locator(".encounter-list li")).toHaveCount(1);
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "我的词库", exact: true })
    .click();
  await expect(page.locator(".library-table tbody tr")).toHaveCount(1);
  await page.locator(".library-table tbody tr").first().click();
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  const note = "把 node 和阅读时遇到的句子联系起来，复习时先回想语境。";
  await page.getByRole("textbox", { name: "我的笔记", exact: true }).fill(note);
  for (const name of ["演示阅读", "复习摘录"])
    await page.getByRole("checkbox", { name: `关联单词本 ${name}`, exact: true }).check();
  // 实际切换主页面后返回，核对未保存草稿仍在；不把内存草稿说成跨重启的资料。
  const nav = page.getByRole("navigation", { name: "主导航" });
  await nav.getByRole("button", { name: "今日学习", exact: false }).click();
  await nav.getByRole("button", { name: "我的词库", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "我的笔记", exact: true })).toHaveValue(note);
  for (const name of ["演示阅读", "复习摘录"])
    await expect(
      page.getByRole("checkbox", { name: `关联单词本 ${name}`, exact: true }),
    ).toBeChecked();
  const save = page.getByRole("button", { name: "保存笔记与归类", exact: true });
  // 让教程同时呈现笔记、多个词本和保存入口；只滚动本轮隐藏应用的真实词卡。
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await expect(page.getByRole("textbox", { name: "我的笔记", exact: true })).toBeInViewport();
  for (const name of ["演示阅读", "复习摘录"])
    await expect(
      page.getByRole("checkbox", { name: `关联单词本 ${name}`, exact: true }),
    ).toBeInViewport();
  await page.screenshot({
    path: path.join(output, "note-multiple-books.png"),
    animations: "disabled",
    scale: "css",
  });
  await save.click();
  await expect(page.getByText("草稿未保存", { exact: true })).toHaveCount(0);
  const detail = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "node" }),
  );
  expect(detail.note).toBe(note);
  expect(detail.books.map((book) => book.name)).toEqual(
    expect.arrayContaining(["演示阅读", "复习摘录"]),
  );
  await page.screenshot({
    path: path.join(output, "note-saved.png"),
    animations: "disabled",
    scale: "css",
  });
  await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "我的笔记", exact: true })).toHaveValue(note);
  await save.scrollIntoViewIfNeeded();
  await expect(save).toBeInViewport();
  await page.screenshot({
    path: path.join(output, "note-multiple-books-dark.png"),
    animations: "disabled",
    scale: "css",
  });
  expect(desktop.pageErrors).toEqual([]);
});
