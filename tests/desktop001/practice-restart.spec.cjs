"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, resizeDesktop } = require("../helpers/electron-fixture.cjs");

// 截图与功能验收共享真实页面、Core 和隔离资料；不操作系统键鼠。
test("重新开始保留范围与模式，清空本轮草稿，不回退分数；插件通知可关闭并持久保存", async ({
  desktopFactory,
}, testInfo) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  let page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["apple", "banana"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `An ${word} example.`,
      });
  });
  const phase = process.env.LEXIMEET_ADDED_VISUAL_PHASE || "after";
  const directory = process.env.LEXIMEET_ADDED_VISUAL_DIR || testInfo.outputPath(phase);
  fs.mkdirSync(directory, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.locator('[data-guide="nav-settings"]').click();
    const nav = page.getByRole("navigation", { name: "设置分类" });
    await nav.getByRole("button", { name: "外观与词卡", exact: true }).click();
    await page.getByRole("combobox", { name: "主题", exact: true }).selectOption(theme);
    await nav.getByRole("button", { name: "采集与快捷键", exact: true }).click();
    await page.screenshot({
      path: path.join(directory, `capture-${theme}.png`),
      animations: "disabled",
    });
    await page.locator('[data-guide="nav-practice"]').click();
    await expect(page.locator(".practice-list-table tbody tr")).toHaveCount(2);
    await page.screenshot({
      path: path.join(directory, `practice-${theme}.png`),
      animations: "disabled",
    });
    if (phase !== "before") {
      await resizeDesktop(desktop, 820, 600);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeVisible();
      await page.screenshot({
        path: path.join(directory, `practice-${theme}-820.png`),
        animations: "disabled",
      });
      await resizeDesktop(desktop, 1321, 864);
    }
  }
  // 改前只留视觉证据，功能断言只在改后的当前构建运行。
  if (phase === "before") return;
  const restart = page.getByRole("button", { name: "重新开始", exact: true });
  const range = page.getByRole("combobox", { name: "练习范围", exact: true });
  const rangeBox = await range.boundingBox(),
    restartBox = await restart.boundingBox();
  expect(restartBox.x).toBeGreaterThan(rangeBox.x + rangeBox.width);
  await page
    .locator(".practice-list-table tbody tr")
    .first()
    .getByRole("button", { name: "熟练 +1", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
          )
        ).familiarity.score,
    )
    .toBe(11);
  const scoreBefore = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
  );
  await restart.click();
  await expect(
    page
      .locator(".practice-list-table tbody tr")
      .first()
      .getByRole("button", { name: "熟练 +1", exact: true }),
  ).toBeEnabled();
  expect(
    (await page.evaluate(() => window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" })))
      .familiarity.score,
  ).toBe(scoreBefore.familiarity.score);
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  const input = page.getByRole("textbox", { name: "练习答案" });
  await input.fill("ap");
  await restart.click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("tab", { name: "单词临摹", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(range).toHaveValue("library");
  await page.locator('[data-guide="nav-settings"]').click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "采集与快捷键", exact: true })
    .click();
  const notification = page.getByRole("checkbox", {
    name: "插件采集成功通知",
    exact: true,
  });
  await expect(notification).toBeChecked();
  await notification.uncheck();
  await expect
    .poll(() =>
      page.evaluate(
        async () =>
          (await window.leximeet.desktopState()).settings.pluginCaptureNotificationsEnabled,
      ),
    )
    .toBe(false);
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  page = desktop.page;
  expect(
    (await page.evaluate(() => window.leximeet.desktopState())).settings
      .pluginCaptureNotificationsEnabled,
  ).toBe(false);
});
