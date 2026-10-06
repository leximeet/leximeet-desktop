"use strict";
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");
const { personalFacts, attachJson } = require("../helpers/journey-evidence.cjs");

test("空资料首次初始化和重开：教学可跳过，不设计划也能使用个人单词本", async ({
  desktopFactory,
}, info) => {
  const executablePath = process.env.LEXIMEET_JOURNEY_EXECUTABLE
    ? requireExecutable(process.env.LEXIMEET_JOURNEY_EXECUTABLE, "LEXIMEET_JOURNEY_EXECUTABLE")
    : undefined;
  const profileDir = desktopFactory.newProfile();
  const clock = desktopFactory.businessClock(profileDir);
  let desktop = await desktopFactory.start({
    profileDir,
    executablePath,
    poisonHostJava: !!executablePath,
    extraEnv: clock.environment,
  });
  let page = desktop.page;
  const fresh = await page.evaluate(() => window.leximeet.desktopState());
  expect(fresh.schema).toBe("leximeet.desktop/1.0.0");
  expect(fresh.today).toBe("2026-10-05");
  expect(fresh.profile).toMatchObject({ planEnabled: false, dailyNew: 10, dailyReview: 20 });
  expect(fresh.profile.goal || "").toBe("");
  expect(fresh.insights).toMatchObject({ practice: 0, encounters: 0 });
  const initial = personalFacts(profileDir);
  expect(initial.schemaVersion).toBe(100);
  expect(initial.words).toEqual([]);
  expect(initial.practice).toEqual([]);
  await expect(page.getByRole("dialog", { name: "欢迎使用词遇", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "personaljourneyword",
      note: "个人词本中的自定义词",
      context: "A personaljourneyword record needs no study plan.",
      sourceTitle: "手动记录",
    }),
  );
  await page.locator('[data-guide="nav-library"]').click();
  await expect(page.locator(".library-table tbody tr")).toHaveCount(1);
  await expect(page.locator(".library-table tbody tr")).toContainText("personaljourneyword");
  const saved = personalFacts(profileDir);
  expect(saved.encounters).toHaveLength(1);
  expect((await page.evaluate(() => window.leximeet.desktopState())).profile.planEnabled).toBe(
    false,
  );
  await desktop.close();
  desktop = await desktopFactory.start({
    profileDir,
    executablePath,
    poisonHostJava: !!executablePath,
    extraEnv: clock.environment,
  });
  page = desktop.page;
  await expect(page.getByRole("dialog", { name: "欢迎使用词遇", exact: true })).toHaveCount(0);
  expect(personalFacts(profileDir)).toEqual(saved);
  expect((await page.evaluate(() => window.leximeet.desktopState())).profile.planEnabled).toBe(
    false,
  );
  await attachJson(info, "installation-initialization-restored", {
    fresh,
    facts: saved,
    restored: await page.evaluate(() => window.leximeet.desktopState()),
    clock: clock.snapshot(),
  });
});
