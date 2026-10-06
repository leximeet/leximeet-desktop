"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const state = (page) => page.evaluate(() => window.leximeet.desktopState());

async function capture(desktop, name, width = 1321, height = 896) {
  await resizeDesktop(desktop, width, height);
  const output = path.join(root, "test-results/reminder-preferences");
  fs.mkdirSync(output, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(output, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
}

for (const theme of ["light", "dark"])
  test(`提醒设置 ${theme}：草稿、空选校验、独立保存、规划不覆盖与重启`, async ({
    desktopFactory,
  }) => {
    const profileDir = desktopFactory.newProfile();
    let desktop = await desktopFactory.start({ profileDir });
    let page = desktop.page;
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.evaluate(async (theme) => {
      await window.leximeet.settings({ theme });
      await window.leximeet.desktopCommand({
        action: "capture",
        word: "apple",
        context: "An apple a day.",
      });
    }, theme);
    await page.reload();
    await page.locator('[data-guide="nav-settings"]').click();
    await page.getByRole("button", { name: "学习提醒", exact: true }).click();
    const section = page.locator(".reminder-settings");
    const save = section.getByRole("button", {
      name: "保存提醒设置",
      exact: true,
    });
    const meaning = section.getByRole("checkbox", {
      name: "看词选义",
      exact: true,
    });
    await expect(section).toContainText("约 30 分钟随机提醒");
    await expect(section.getByRole("combobox")).toHaveCount(0);
    await expect(section.getByRole("checkbox")).toHaveCount(6);
    await expect(meaning).toBeChecked();
    await expect(save).toBeDisabled();
    const before = await state(page);
    await meaning.uncheck();
    await expect(save).toBeDisabled();
    await expect(section.getByRole("alert")).toContainText("请至少选择一种练习");
    await section.getByRole("checkbox", { name: "单词默写", exact: true }).check();
    // 编辑只是草稿；不提前写入资料或启用规划。
    expect((await state(page)).profile).toEqual(before.profile);
    await save.click();
    await expect(save).toBeDisabled();
    await expect(section.getByRole("status")).toContainText("提醒设置已保存");
    const saved = await state(page);
    expect(saved.profile).toEqual({
      ...before.profile,
      revision: before.profile.revision + 1,
      reminderModes: ["recall"],
    });
    expect(saved.insights).toEqual(before.insights);
    expect(saved.profile.planEnabled).toBe(false);
    await capture(desktop, `settings-${theme}`);
    await capture(desktop, `settings-narrow-${theme}`, 820, 728);
    await expect(save).toBeInViewport();

    await page.locator('[data-guide="nav-plan"]').click();
    await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "设置学习规划",
      exact: true,
    });
    await dialog.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思");
    await dialog.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
    await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    await expect(dialog.getByRole("checkbox")).toHaveCount(1);
    await expect(dialog.getByLabel("提醒间隔", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    expect((await state(page)).profile).toMatchObject({
      planEnabled: true,
      reminderModes: ["recall"],
      reminderInterval: 30,
    });
    await desktop.close();
    desktop = await desktopFactory.start({ profileDir });
    page = desktop.page;
    expect((await state(page)).profile).toMatchObject({
      planEnabled: true,
      reminderModes: ["recall"],
      reminderInterval: 30,
    });
    await page.locator('[data-guide="nav-settings"]').click();
    await page.getByRole("button", { name: "学习提醒", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "单词默写", exact: true })).toBeChecked();
    expect(desktop.pageErrors).toEqual([]);
  });
