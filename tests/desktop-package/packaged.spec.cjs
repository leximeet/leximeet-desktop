"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");
const { findArtifact } = require("../../scripts/artifacts.cjs");
const { dictionarySource } = require("../helpers/dictionary-source.cjs");

test("真实 1.0.0 应用包：离线 Core Text、随包 Java 与连接服务、资料重启恢复", async ({
  desktopFactory,
}) => {
  // 正式包也真实构建完整 Full 索引，不用小词典替代；有界预算与原生用例一致。
  test.setTimeout(600000);
  const executablePath = requireExecutable(
    process.env.LEXIMEET_PACKAGED_EXECUTABLE || findArtifact("executable"),
    "LEXIMEET_PACKAGED_EXECUTABLE",
  );
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({
    executablePath,
    profileDir,
    poisonHostJava: true,
    extraEnv: { LEXIMEET_DICTIONARY_SOURCE: dictionarySource() },
  });
  expect(await desktop.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  const resources = await desktop.app.evaluate(() => process.resourcesPath);
  expect(fs.existsSync(path.join(resources, "native-host", "host", "main.cjs"))).toBe(true);
  expect(fs.existsSync(path.join(profileDir, "native-messaging/gateway.properties"))).toBe(false);
  expect(desktop.runtime.plugins).toBe(true);
  expect(desktop.runtime.connectorProtocolVersion).toBe("lmcp/1.0.0");
  const java = spawnSync(path.join(resources, "runtime/bin/java"), ["-version"], {
    encoding: "utf8",
  });
  expect(java.status).toBe(0);
  expect(java.stderr).toMatch(/version "21\./);
  const state = () => desktop.page.evaluate(() => window.leximeet.desktopState());
  await expect.poll(async () => (await state()).dictionary.entryCount).toBe(117902);
  expect((await state()).guide.completed).toHaveLength(0);
  await expect(desktop.page.locator(".guide-invitation-card")).toBeVisible();
  await expect(desktop.page.locator(".guide-coach")).toHaveCount(0);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect.poll(async () => (await state()).guide.active).toBe(false);
  const detail = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "serendipity" }),
  );
  expect(detail.entry.schema_version).toBe("leximeet.entry.v2");
  expect(detail.familiarity).toMatchObject({
    score: 10,
    maximum: 30,
    ruleVersion: "leximeet.learning/2",
  });
  const result = await desktop.page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "serendipity",
      context: "An offline desktop keeps my serendipity context.",
    }),
  );
  expect(result.insights.encounters).toBe(1);
  await desktop.page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "practiceRecord",
      wordId: "serendipity",
      mode: "copy",
      answer: "serendipity",
      submissionId: crypto.randomUUID(),
    }),
  );
  // 应用包也走新的两步规划，确认打包代码与随包 Core 都支持原子保存。
  await desktop.page.locator('[data-guide="nav-plan"]').click();
  await desktop.page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  const planning = desktop.page.getByRole("dialog", {
    name: "设置学习规划",
    exact: true,
  });
  await planning.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思词汇");
  await planning.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
  await planning.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await expect(planning.getByLabel("提醒间隔", { exact: true })).toHaveCount(0);
  await expect(planning.getByRole("checkbox")).toHaveCount(1);
  await planning.getByLabel("每天复习", { exact: true }).fill("0");
  await planning.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(planning).toHaveCount(0);
  const savedPlan = (await state()).profile;
  expect(savedPlan.planId).toBeTruthy();
  expect(savedPlan.dailyReview).toBe(0);
  expect(savedPlan.reminderInterval).toBe(30);
  // 实际应用包通过新设置页保存，避免只验证源码 API 而漏打包前端。
  await desktop.page.locator('[data-guide="nav-settings"]').click();
  await desktop.page.getByRole("button", { name: "学习提醒", exact: true }).click();
  const reminder = desktop.page.locator(".reminder-settings");
  await expect(reminder).toContainText("约 30 分钟随机提醒");
  await reminder.getByRole("checkbox", { name: "看词选义", exact: true }).uncheck();
  await reminder.getByRole("checkbox", { name: "单词默写", exact: true }).check();
  await reminder.getByRole("button", { name: "保存提醒设置", exact: true }).click();
  await expect.poll(async () => (await state()).profile.reminderModes).toEqual(["recall"]);
  expect((await state()).profile).toMatchObject({
    planId: savedPlan.planId,
    startedOn: savedPlan.startedOn,
    dailyNew: 10,
    dailyReview: 0,
  });
  await desktop.page.evaluate(() =>
    window.leximeet.dictionaryAction({
      action: "install",
      edition: "full-text",
    }),
  );
  expect((await state()).dictionary.entryCount).toBe(811092);
  await desktop.page.evaluate(() => window.leximeet.dictionaryAction({ action: "rollback" }));
  expect((await state()).dictionary.entryCount).toBe(117902);
  await desktop.close();
  desktop = await desktopFactory.start({
    executablePath,
    profileDir,
    poisonHostJava: true,
    extraEnv: { LEXIMEET_DICTIONARY_SOURCE: dictionarySource() },
  });
  const restored = await state();
  expect(restored.dictionary.entryCount).toBe(117902);
  expect(restored.guide.active).toBe(false);
  await expect(desktop.page.locator(".guide-invitation-card")).toHaveCount(0);
  expect(restored.insights.encounters).toBe(1);
  expect(restored.insights.manualWords).toBe(1);
  expect(restored.profile).toMatchObject({
    planId: savedPlan.planId,
    goal: savedPlan.goal,
    startedOn: savedPlan.startedOn,
    dailyNew: 10,
    dailyReview: 0,
    reminderInterval: 30,
  });
  expect(restored.settings.clipboardCaptureEnabled).toBe(false);
  expect(restored.profile.reminderModes).toEqual(["recall"]);
  expect(
    (
      await desktop.page.evaluate(() =>
        window.leximeet.desktopQuery({ kind: "detail", wordId: "serendipity" }),
      )
    ).familiarity.score,
  ).toBe(11);
  const encounter = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "encounters" }),
  );
  expect(encounter.encounters[0].context).toBe("An offline desktop keeps my serendipity context.");
});
