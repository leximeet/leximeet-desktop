"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");
const { personalFacts } = require("../helpers/journey-evidence.cjs");
const fs = require("node:fs");
const path = require("node:path");

test("真实连续选义：题词与选项同步，保存不误报错误、不跳布局，确认一秒后继续", async ({
  desktopFactory,
}, testInfo) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["way", "time", "state"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `This ${word} matters.`,
      });
  });
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "看词选义", exact: true }).click();
  const observations = [];
  for (let turn = 0; turn < 3; turn++) {
    const first = await page.locator(".practice-headword").innerText();
    const expectedMeaning = await page.evaluate(async (wordId) => {
      const position = await window.leximeet.desktopQuery({
        kind: "practice",
        scope: "library",
        mode: "meaning-choice",
        wordId,
      });
      return (
        await window.leximeet.desktopQuery({
          kind: "practiceQuestion",
          scope: "library",
          mode: "meaning-choice",
          wordId,
          attemptId: position.draft.attemptId,
        })
      ).meaning;
    }, first);
    const right = page.locator(".meaning-choice").filter({ hasText: expectedMeaning });
    await expect(right).toHaveCount(1);
    await page.evaluate((first) => {
      const stage = document.querySelector(".practice-stage");
      const timing = (window.__practiceContinuity = {
        first,
        top: stage.getBoundingClientRect().top,
        correctAt: null,
        nextAt: null,
        alerts: [],
        tops: [],
        blanks: 0,
        choices: [...stage.querySelectorAll(".meaning-choice strong")].map(
          (item) => item.textContent,
        ),
      });
      const observer = new MutationObserver(() => {
        const stage = document.querySelector(".practice-stage");
        const word = stage?.querySelector(".practice-headword")?.textContent?.trim();
        const alert = document.querySelector(".practice-recovery");
        if (alert) timing.alerts.push(alert.textContent.trim());
        if (word === first) timing.tops.push(stage.getBoundingClientRect().top);
        if (stage?.classList.contains("correct") && timing.correctAt === null)
          timing.correctAt = performance.now();
        if (!stage && !document.querySelector(".practice-page > .empty h2")) timing.blanks++;
        if (
          (word && word !== first) ||
          document.querySelector(".practice-page > .empty h2")?.textContent === "已完成本轮练习"
        ) {
          timing.nextAt = performance.now();
          observer.disconnect();
        }
      });
      observer.observe(document.querySelector(".practice-page"), {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
    }, first);
    // 业务 DOM 点击仍由 renderer 处理；连续点击不能把下一题的选项提交给上一题。
    await right.evaluate((button) => {
      button.click();
      button.click();
      button.click();
    });
    await expect(page.locator(".practice-feedback")).toContainText("正确 · 已记录");
    await expect(right).toBeDisabled();
    if (turn === 0 && process.env.LEXIMEET_PRACTICE_CAPTURE) {
      fs.mkdirSync(process.env.LEXIMEET_PRACTICE_CAPTURE, { recursive: true });
      await page.screenshot({
        path: path.join(process.env.LEXIMEET_PRACTICE_CAPTURE, "choice-confirmed.png"),
        animations: "disabled",
        scale: "css",
      });
    }
    await expect.poll(() => page.evaluate(() => window.__practiceContinuity.nextAt)).not.toBeNull();
    observations.push(await page.evaluate(() => window.__practiceContinuity));
  }
  await testInfo.attach("practice-continuity", {
    body: Buffer.from(JSON.stringify(observations, null, 2)),
    contentType: "application/json",
  });
  if (process.env.LEXIMEET_PRACTICE_CAPTURE)
    fs.writeFileSync(
      path.join(process.env.LEXIMEET_PRACTICE_CAPTURE, "choice-continuity.json"),
      JSON.stringify(observations, null, 2),
    );
  expect(personalFacts(desktop.profileDir).practice).toHaveLength(3);
  expect(observations.map((item) => item.first)).toEqual(["way", "time", "state"]);
  for (const item of observations) {
    expect(item.alerts, "正常保存不能显示尚未确认或重试红条").toEqual([]);
    expect(
      item.tops.every((top) => Math.abs(top - item.top) < 1),
      "选择反馈期间题卡不能上下跳动",
    ).toBe(true);
    expect(item.blanks).toBe(0);
    expect(item.nextAt - item.correctAt).toBeGreaterThanOrEqual(950);
    expect(item.nextAt - item.correctAt).toBeLessThan(1900);
  }
  expect(desktop.pageErrors).toEqual([]);
});

test("真实 Core 暂停失败：原题原选项可见，重启后只恢复原提交一次再继续", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["way", "time"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `This ${word} matters.`,
      });
  });
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "看词选义", exact: true }).click();
  // 标签切换包含异步冻结题目；必须等实际选项可交互后再读取本题 attempt。
  await expect(page.locator(".practice-headword")).toHaveText("way");
  await expect.poll(() => page.locator(".meaning-choice strong").count()).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".meaning-choice").first()).toBeEnabled();
  const before = await page.locator(".meaning-choice strong").allTextContents();
  const meaning = await page.evaluate(async () => {
    const draft = await window.leximeet.desktopQuery({
      kind: "practice",
      scope: "library",
      mode: "meaning-choice",
      wordId: "way",
    });
    return (
      await window.leximeet.desktopQuery({
        kind: "practiceQuestion",
        scope: "library",
        mode: "meaning-choice",
        wordId: "way",
        attemptId: draft.draft.attemptId,
      })
    ).meaning;
  });
  // 只停止 Main 自己启动且参数匹配本例 profile 的 Java 子进程，不扫描或终止用户进程。
  await desktop.app.evaluate(async (_, profileDir) => {
    const children = process
      ._getActiveHandles()
      .filter(
        (handle) =>
          Array.isArray(handle.spawnargs) &&
          handle.spawnargs.includes("--data-dir") &&
          handle.spawnargs[handle.spawnargs.indexOf("--data-dir") + 1] === `${profileDir}/core` &&
          handle.pid &&
          handle.exitCode === null,
      );
    if (children.length !== 1) throw new Error("无法唯一定位本例 Core 子进程，禁止停止其他进程");
    const child = children[0];
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("本例 Core 未正常退出")), 5000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
  }, desktop.profileDir);
  await page.locator(".meaning-choice").filter({ hasText: meaning }).click();
  await expect(page.locator(".practice-recovery")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeEnabled();
  await expect(page.locator(".practice-headword")).toHaveText("way");
  await expect(page.locator(".meaning-choice strong")).toHaveText(before);
  for (const button of await page.locator(".meaning-choice").all())
    await expect(button).toBeDisabled();
  expect(personalFacts(desktop.profileDir).practice).toHaveLength(0);
  await page.evaluate(() => window.leximeet.desktopAction({ action: "restartCore" }));
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.locator(".practice-feedback")).toContainText("正确 · 已记录");
  await expect(page.locator(".practice-recovery")).toHaveCount(0);
  await expect(page.locator(".practice-headword")).toHaveText("time");
  expect(personalFacts(desktop.profileDir).practice).toHaveLength(1);
  const score = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "way" }),
  );
  expect(score.familiarity.score).toBe(11);
  expect(desktop.pageErrors).toEqual([]);
});
