"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");

// 用真实原生应用和真实 Core 资料拍摄；只输入公开合成句子，不接触系统剪贴板。
test("真实使用截图：首次打开、手动遇见、词库与临摹的明暗宽窄对照", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  const phase = process.env.LEXIMEET_PRACTICE_CAPTURE === "before" ? "before" : "after";
  const output =
    process.env.LEXIMEET_USAGE_CAPTURE || path.join(root, "test-results/practice-usage", phase);
  fs.mkdirSync(output, { recursive: true });
  async function shot(name, target = page) {
    await target.screenshot({
      path: path.join(output, `${name}.png`),
      animations: "disabled",
      scale: "css",
    });
  }
  const size = (width, height) => resizeDesktop(desktop, width, height);
  async function nav(name) {
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: false })
      .click();
  }
  await size(1321, 864);
  await expect(page.locator(".guide-invitation-card")).toBeVisible();
  await shot("first-open");
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(page.locator(".guide-invitation-card")).toHaveCount(0);
  await shot("today");
  await nav("遇见记录");
  await page.getByRole("button", { name: "记录新的遇见", exact: true }).click();
  await expect
    .poll(() => desktop.app.windows().some((item) => item.url().endsWith("#capture-editor")))
    .toBe(true);
  const capture = desktop.app.windows().find((item) => item.url().endsWith("#capture-editor"));
  await capture.getByRole("textbox", { name: "捕获单词", exact: true }).fill("node");
  await capture
    .getByRole("textbox", { name: "捕获语境", exact: true })
    .fill("Node connects a useful idea to another idea.");
  await shot("manual-capture", capture);
  await capture.getByRole("button", { name: "确认保存遇见", exact: true }).click();
  await expect
    .poll(
      async () => (await page.evaluate(() => window.leximeet.desktopState())).insights.encounters,
    )
    .toBe(1);
  await expect(page.locator(".encounter-list li")).toHaveCount(1);
  await shot("encounters");
  await nav("我的词库");
  await expect(page.locator(".word-table tbody tr")).toHaveCount(1);
  await page.locator(".word-table tbody tr").first().click();
  await expect(page.locator(".d-word-card h2")).toHaveText("node");
  await shot("word-library");
  await nav("学习规划");
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  await expect(page.locator(".planning-dialog")).toBeVisible();
  await shot("planning-target");
  await page.keyboard.press("Escape");
  await nav("练习中心");
  await expect(page.locator(".practice-list-table")).toBeVisible();
  await shot("practice-list");
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  await page.getByRole("textbox", { name: "练习答案", exact: true }).fill("no");
  await expect(page.locator(".spelling-letters .typed")).toHaveCount(2);
  await shot("copy-light");
  await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await shot("copy-dark");
  await size(820, 728);
  await shot("copy-dark-narrow");
  if (phase === "after") {
    await expect(page.locator(".spelling-letters .ghost")).toHaveCount(2);
    const styles = await page.locator(".spelling-letters").evaluate((el) => ({
      typed: getComputedStyle(el.querySelector(".typed")).color,
      ghost: getComputedStyle(el.querySelector(".ghost")).color,
      fits: el.scrollWidth <= el.clientWidth,
    }));
    expect(styles.typed).not.toBe(styles.ghost);
    expect(styles.fits).toBe(true);
    await size(1321, 864);
    await page.getByRole("button", { name: "切换明亮主题", exact: true }).click();
    await nav("我的词库");
    await page.locator(".word-table tbody tr").first().click();
    await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
    await page
      .getByRole("textbox", { name: "我的笔记", exact: true })
      .fill("把 node 和阅读时遇到的句子联系起来。");
    await shot("word-note");
    await page.getByRole("button", { name: "保存笔记与归类", exact: true }).click();
    await nav("学习规划");
    await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
    await page.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).first().click();
    await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    await expect(page.getByRole("spinbutton", { name: "每天新学", exact: true })).toHaveValue("10");
    await expect(page.getByRole("spinbutton", { name: "每天复习", exact: true })).toHaveValue("20");
    await expect(page.getByRole("button", { name: "保存学习规划", exact: true })).toBeEnabled();
    await shot("planning-schedule");
    await page.getByRole("button", { name: "保存学习规划", exact: true }).click();
    await expect(page.locator(".planning-dialog")).toHaveCount(0);
    await expect
      .poll(
        async () => (await page.evaluate(() => window.leximeet.desktopState())).profile.planEnabled,
      )
      .toBe(true);
  }
  expect(desktop.pageErrors).toEqual([]);
});
