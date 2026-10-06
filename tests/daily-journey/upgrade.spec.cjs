"use strict";
const fs = require("node:fs");
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");
const { compareVersion } = require("../helpers/versions.cjs");
const {
  personalFacts,
  applicationEvidence,
  attachJson,
} = require("../helpers/journey-evidence.cjs");

test("同一 1.0.0 模型的两版真实 app 替换：旧资料保留，新版本继续学习与采集", async ({
  desktopFactory,
}, info) => {
  const oldExecutable = requireExecutable(
    process.env.LEXIMEET_JOURNEY_UPGRADE_FROM,
    "LEXIMEET_JOURNEY_UPGRADE_FROM",
  );
  const newExecutable = requireExecutable(
    process.env.LEXIMEET_JOURNEY_EXECUTABLE,
    "LEXIMEET_JOURNEY_EXECUTABLE",
  );
  expect(fs.realpathSync(newExecutable), "同一可执行文件不能冒充版本升级").not.toBe(
    fs.realpathSync(oldExecutable),
  );
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({
    profileDir,
    executablePath: oldExecutable,
    poisonHostJava: true,
  });
  const oldApp = await applicationEvidence(desktop);
  // 当前覆盖 1.0.0 模型的候选替换，可复用于 dev.3 → dev.4；0.x 不进入此验收。
  expect(oldApp.version).toMatch(/^1\.0\.0(?:[-+]|$)/);
  let page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    await window.leximeet.desktopCommand({ action: "createBook", name: "升级保留的词本" });
    const book = (await window.leximeet.desktopState()).books.find(
      (item) => item.name === "升级保留的词本",
    );
    await window.leximeet.desktopCommand({
      action: "capture",
      word: "apple",
      context: "An apple is part of my previous version record.",
      sourceTitle: "旧版手动遇见",
    });
    await window.leximeet.desktopCommand({
      action: "collect",
      word: "apple",
      note: "旧应用留下的个人笔记",
      bookIds: [book.id],
    });
    for (const mode of ["copy", "recall"])
      await window.leximeet.desktopCommand({
        action: "practiceRecord",
        wordId: "apple",
        mode,
        answer: "apple",
        submissionId: crypto.randomUUID(),
      });
  });
  await page.locator('[data-guide="nav-plan"]').click();
  await page.getByRole("button", { name: "设置学习规划", exact: true }).click();
  const plan = page.getByRole("dialog", { name: "设置学习规划", exact: true });
  await plan.getByRole("searchbox", { name: "搜索学习目标" }).fill("雅思词汇");
  await plan.locator(".planning-catalog").filter({ hasText: "雅思词汇" }).click();
  await plan.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await plan.getByLabel("每天新学", { exact: true }).fill("5");
  await plan.getByLabel("每天复习", { exact: true }).fill("4");
  await plan.getByLabel("学习提醒", { exact: true }).uncheck();
  await plan.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(plan).toHaveCount(0);
  const before = await page.evaluate(() => window.leximeet.desktopState());
  const detailBefore = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
  );
  expect(detailBefore.familiarity.score).toBe(13);
  const factsBefore = personalFacts(profileDir);
  expect(factsBefore.schemaVersion).toBe(100);
  await attachJson(info, "upgrade-before", {
    application: oldApp,
    state: before,
    facts: factsBefore,
    word: detailBefore,
  });
  await desktop.close();

  // 时间文件只由新版本测试入口加载，旧包不需测试时钟能力；仍是同一自有 profile。
  const clock = desktopFactory.businessClock(profileDir, {
    instant: new Date(Date.now() + 86400000).toISOString(),
  });
  desktop = await desktopFactory.start({
    profileDir,
    executablePath: newExecutable,
    poisonHostJava: true,
    extraEnv: clock.environment,
  });
  page = desktop.page;
  const newApp = await applicationEvidence(desktop);
  expect(
    compareVersion(newApp.version, oldApp.version),
    "新 app 的实际版本必须严格增加",
  ).toBeGreaterThan(0);
  expect(newApp.appAsarSha256).not.toBe(oldApp.appAsarSha256);
  expect(newApp.coreJarSha256).not.toBe(oldApp.coreJarSha256);
  const after = await page.evaluate(() => window.leximeet.desktopState());
  expect(after.schema).toBe("leximeet.desktop/1.0.0");
  expect(after.profile).toEqual(before.profile);
  expect(after.guide).toEqual(before.guide);
  expect(after.books).toEqual(before.books);
  for (const [key, value] of Object.entries(before.settings))
    expect(after.settings[key], `保留旧用户偏好 ${key}`).toEqual(value);
  expect(after.settings).toMatchObject({
    captureDuplicateWindowDays: 7,
    captureSensitiveRedactionEnabled: true,
    captureContextMaxLength: 500,
  });
  expect(personalFacts(profileDir), "当前 1.0.0 资料事件和关系不能因换 app 丢失").toEqual(
    factsBefore,
  );
  const detailAfter = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
  );
  expect(detailAfter.id).toBe(detailBefore.id);
  expect(detailAfter.note).toBe(detailBefore.note);
  expect(detailAfter.books).toEqual(detailBefore.books);
  expect(detailAfter.familiarity.score).toBe(13);
  await expect(page.locator(".guide-invitation-card")).toHaveCount(0);
  await page.locator('[data-guide="nav-library"]').click();
  // 目标词也进入词库，原收藏不一定在首页；用真实搜索找到准确词头，不能假定分页顺序。
  await page.getByRole("textbox", { name: "搜索单词", exact: true }).fill("apple");
  const retainedRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("cell", { name: "apple", exact: true }) });
  await expect(retainedRow).toHaveCount(1);
  await retainedRow.click();
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await page.getByRole("textbox", { name: "我的笔记" }).fill("升级后继续补充个人笔记");
  await page.getByRole("button", { name: "保存笔记与归类", exact: true }).click();
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
          )
        ).note,
    )
    .toBe("升级后继续补充个人笔记");
  await page.locator('[data-guide="nav-practice"]').click();
  // 当前学习目标也会进入“我的词库”，从真实旧词本选出原词，避免误答目标队列的另一词。
  const retainedBook = before.books.find((item) => item.name === "升级保留的词本");
  await page
    .getByRole("combobox", { name: "练习范围", exact: true })
    .selectOption(`book:${retainedBook.id}`);
  // 已打开的范围含草稿，按用户真实交互保存后切换；确认前模式入口应保持禁用。
  const scopeConfirmation = page.getByRole("region", { name: "切换练习范围确认", exact: true });
  await scopeConfirmation.getByRole("button", { name: "保存并切换", exact: true }).click();
  await expect(scopeConfirmation).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "练习范围", exact: true })).toHaveValue(
    `book:${retainedBook.id}`,
  );
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  await expect(page.locator(".spelling-letters")).toHaveText("apple");
  await page
    .getByRole("textbox", { name: "练习答案", exact: true })
    .pressSequentially("apple", { delay: 15 });
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(() =>
            window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
          )
        ).familiarity.score,
    )
    .toBe(14);
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "apple",
      context: "An apple gains a new context after the application upgrade.",
      sourceTitle: "新版手动遇见",
    }),
  );
  const continued = personalFacts(profileDir);
  expect(continued.practice).toHaveLength(factsBefore.practice.length + 1);
  expect(continued.encounters).toHaveLength(factsBefore.encounters.length + 1);
  expect(continued.encounters).toEqual(expect.arrayContaining(factsBefore.encounters));
  await attachJson(info, "upgrade-after-and-continued", {
    application: newApp,
    clock: clock.snapshot(),
    state: await page.evaluate(() => window.leximeet.desktopState()),
    facts: continued,
  });
  await desktop.close();
  desktop = await desktopFactory.start({
    profileDir,
    executablePath: newExecutable,
    poisonHostJava: true,
    extraEnv: clock.environment,
  });
  expect(personalFacts(profileDir)).toEqual(continued);
  expect(
    (
      await desktop.page.evaluate(() =>
        window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" }),
      )
    ).note,
  ).toBe("升级后继续补充个人笔记");
  await attachJson(
    info,
    "upgrade-restored",
    await desktop.page.evaluate(() => window.leximeet.desktopState()),
  );
});
