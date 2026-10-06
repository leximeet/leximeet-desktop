"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { personalFacts } = require("../helpers/journey-evidence.cjs");
test("真实学习预测：候选与今日任务一致，区间只读，回收更新预测且明暗窄窗可用", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.locator('[data-guide="nav-plan"]').click();
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "设置学习规划", exact: true });
  await dialog.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思");
  await dialog.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
  await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const panel = page.getByRole("region", { name: "学习预测面板" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("tab")).toHaveCount(7);
  const state = await page.evaluate(() => window.leximeet.desktopState());
  const forecast = await page.evaluate(
    (goal) =>
      window.leximeet.desktopQuery({ kind: "planningPreview", goal, dailyNew: 10, daysAhead: 7 }),
    state.profile.goal,
  );
  expect(forecast.firstDays[0].words.map((x) => x.word)).toEqual(
    state.queue.tasks.filter((x) => x.kind === "new").map((x) => x.word),
  );
  await expect(panel.locator(".forecast-word")).toHaveText(
    forecast.firstDays[0].words.map((x) => x.word),
  );
  const original = personalFacts(desktop.profileDir);
  await panel.getByLabel("预测区间").selectOption("all");
  await expect(panel.getByRole("img")).toContainText(forecast.total.toString());
  await panel.getByRole("tab").nth(1).click();
  await expect(panel.locator(".forecast-word")).toHaveText(
    forecast.firstDays[1].words.map((x) => x.word),
  );
  const after = personalFacts(desktop.profileDir);
  expect(after.practice).toEqual(original.practice);
  expect(after.encounters).toEqual(original.encounters);
  // 正式 Core 命令模拟另一个窗口的回收操作；重新读取页面必须采用同一引用规则。
  const removed = forecast.firstDays[0].words[0];
  await page.evaluate(
    (wordId) => window.leximeet.desktopCommand({ action: "trash", wordId }),
    removed.id,
  );
  await page.reload();
  await page.locator('[data-guide="nav-plan"]').click();
  await expect(panel.locator(".forecast-metrics")).toContainText(
    (forecast.total - 1).toLocaleString(),
  );
  await expect(
    panel.locator(".forecast-word").filter({ hasText: new RegExp("^" + removed.word + "$") }),
  ).toHaveCount(0);
  const output =
    process.env.LEXIMEET_USABILITY_CAPTURE ||
    path.join(root, "test-results/desktop-usability/after");
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, width, height] of [
    ["light", 1321, 896],
    ["dark", 1321, 896],
    ["dark", 820, 728],
  ]) {
    await page.evaluate((theme) => window.leximeet.settings({ theme }), theme);
    await page.reload();
    await resizeDesktop(desktop, width, height);
    await page.locator('[data-guide="nav-plan"]').click();
    await expect(panel).toBeVisible();
    expect(await panel.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await page.screenshot({
      path: path.join(output, `planning-${theme}-${width}.png`),
      scale: "css",
      animations: "disabled",
    });
  }
  expect(desktop.pageErrors).toEqual([]);
});
