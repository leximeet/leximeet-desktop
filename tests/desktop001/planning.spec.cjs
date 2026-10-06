"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const state = (page) => page.evaluate(() => window.leximeet.desktopState());

test("规划切换步骤恢复表单顶部，滚动的目标列表不隐藏新学设置；返回不丢草稿", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.locator('[data-guide="nav-plan"]').click();
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  const dialog = page.locator(".planning-dialog"),
    body = dialog.locator(".planning-body");
  await dialog.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).first().click();
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  const daily = dialog.getByLabel("每天新学", { exact: true });
  expect(
    await daily.evaluate((element) => {
      const box = element.getBoundingClientRect(),
        viewport = element.closest(".planning-body").getBoundingClientRect();
      return box.top >= viewport.top && box.bottom <= viewport.bottom;
    }),
  ).toBe(true);
  await daily.fill("15");
  await body.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await dialog.getByRole("button", { name: "上一步", exact: true }).click();
  await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
  await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await expect(daily).toHaveValue("15");
  expect((await state(page)).profile.goal).toBeFalsy();
});

async function capture(desktop, name, width = 1321, height = 896) {
  await resizeDesktop(desktop, width, height);
  const output = path.join(root, "test-results/planning-alignment");
  fs.mkdirSync(output, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(output, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
}
for (const theme of ["light", "dark"])
  test(`学习规划 ${theme}：选择、回退、取消、预览、原子保存、调整与重启`, async ({
    desktopFactory,
  }) => {
    const profileDir = desktopFactory.newProfile();
    let desktop = await desktopFactory.start({ profileDir }),
      page = desktop.page;
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.evaluate((theme) => window.leximeet.settings({ theme }), theme);
    await page.reload();
    await page.locator('[data-guide="nav-plan"]').click();
    const original = (await state(page)).profile;
    await capture(desktop, `empty-${theme}`);
    await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
    const dialog = page.getByRole("dialog", {
      name: "设置学习规划",
      exact: true,
    });
    await expect(
      dialog.getByRole("button", { name: "下一步：设置计划", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思");
    await dialog.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
    await capture(desktop, `target-${theme}`);
    await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    await expect(dialog.getByLabel("每天新学", { exact: true })).toHaveValue("10");
    await expect(dialog.getByLabel("每天复习", { exact: true })).toHaveValue("20");
    await dialog.getByLabel("每天新学", { exact: true }).fill("25");
    await dialog.getByLabel("每天复习", { exact: true }).fill("0");
    await expect(dialog.locator(".planning-forecast li")).toHaveCount(5);
    expect((await state(page)).profile).toEqual(original);
    await dialog.getByRole("button", { name: "上一步", exact: true }).click();
    await expect(dialog.locator('.planning-catalog[aria-pressed="true"]')).toContainText("雅思");
    await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    await expect(dialog.getByLabel("每天新学", { exact: true })).toHaveValue("25");
    await dialog.getByRole("button", { name: "关闭对话框", exact: true }).click();
    expect((await state(page)).profile).toEqual(original);
    await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
    await dialog.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思");
    await dialog.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
    await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    await expect(dialog.getByLabel("提醒间隔", { exact: true })).toHaveCount(0);
    await expect(dialog.getByRole("checkbox", { name: "看词选义", exact: true })).toHaveCount(0);
    await capture(desktop, `schedule-${theme}`);
    await capture(desktop, `schedule-narrow-${theme}`, 820, 728);
    await expect(
      dialog.getByRole("button", { name: "保存学习规划", exact: true }),
    ).toBeInViewport();
    await dialog.getByLabel("每天复习", { exact: true }).fill("0");
    await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const saved = (await state(page)).profile;
    expect(saved).toMatchObject({
      planEnabled: true,
      dailyNew: 10,
      dailyReview: 0,
      reminderEnabled: true,
      studyStart: "08:00",
      studyEnd: "20:00",
      reminderModes: ["meaning-choice"],
      reminderInterval: 30,
    });
    expect(saved.planId).toBeTruthy();
    await capture(desktop, `overview-${theme}`);
    await page.getByRole("button", { name: "调整计划", exact: true }).click();
    const adjust = page.getByRole("dialog", {
      name: "调整学习计划",
      exact: true,
    });
    await expect(adjust.locator('[data-plan-step="schedule"]')).toBeVisible();
    await expect(adjust.getByRole("searchbox")).toHaveCount(0);
    await adjust.getByLabel("每天新学", { exact: true }).fill("30");
    await adjust.getByLabel("学习提醒", { exact: true }).uncheck();
    await expect(adjust.getByLabel("学习开始时间", { exact: true })).toHaveCount(0);
    await adjust.getByRole("button", { name: "保存学习计划", exact: true }).click();
    await expect(adjust).toHaveCount(0);
    expect((await state(page)).profile).toMatchObject({
      goal: saved.goal,
      planId: saved.planId,
      startedOn: saved.startedOn,
      dailyNew: 30,
      reminderEnabled: false,
    });
    await desktop.close();
    desktop = await desktopFactory.start({ profileDir });
    page = desktop.page;
    expect((await state(page)).profile).toMatchObject({
      planId: saved.planId,
      dailyNew: 30,
      dailyReview: 0,
      reminderEnabled: false,
      reminderModes: ["meaning-choice"],
    });
    expect(desktop.pageErrors).toEqual([]);
  });

test("输入法组词可见且 Enter 不被截断，确认后临摹自动保存", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "apple",
      context: "An apple a day.",
    }),
  );
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  const field = page.getByRole("textbox", { name: "练习答案" });
  await field.click();
  await field.pressSequentially("ap");
  await expect(field).toHaveValue("ap");
  // Chromium 文档事件回归；不操作宿主输入法，人工候选窗仍需本机验收。
  const prevented = await field.evaluate((input) => {
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
    input.value = "apple";
    input.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        data: "ple",
        isComposing: true,
      }),
    );
    const key = new KeyboardEvent("keydown", {
      key: "Enter",
      isComposing: true,
      cancelable: true,
      bubbles: true,
    });
    input.dispatchEvent(key);
    return key.defaultPrevented;
  });
  expect(prevented).toBe(false);
  await expect(page.locator(".spelling-composition")).toContainText("apple");
  expect((await state(page)).insights.practice).toBe(0);
  await field.evaluate((input) =>
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "ple" })),
  );
  await expect.poll(async () => (await state(page)).insights.practice).toBe(1);
  expect(desktop.pageErrors).toEqual([]);
});
