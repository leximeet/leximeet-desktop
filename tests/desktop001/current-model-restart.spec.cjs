"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");
test("当前规则从新库直接学习，同一实例重启保留资料与分数，无升级确认", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await desktop.page.evaluate(async () => {
    await window.leximeet.desktopCommand({
      action: "capture",
      word: "apple",
      context: "An apple a day.",
    });
    await window.leximeet.desktopCommand({
      action: "practiceRecord",
      wordId: "apple",
      mode: "copy",
      answer: "apple",
      submissionId: crypto.randomUUID(),
    });
  });
  const score = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
  );
  expect(score.familiarity.score).toBe(11);
  await expect(desktop.page.locator(".learning-migration-notice")).toHaveCount(0);
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  const restored = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
  );
  expect(restored.familiarity.score).toBe(11);
  expect(
    (await desktop.page.evaluate(() => window.leximeet.desktopState())).insights.encounters,
  ).toBe(1);
  await expect(desktop.page.getByRole("dialog", { name: "确认学习规则升级" })).toHaveCount(0);
});
