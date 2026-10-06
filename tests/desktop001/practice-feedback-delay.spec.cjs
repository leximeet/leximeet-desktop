"use strict";
const { test, expect, root } = require("../helpers/electron-fixture.cjs");
const { personalFacts } = require("../helpers/journey-evidence.cjs");
const fs = require("node:fs");
const path = require("node:path");

test("真实正确选义保持一秒再换题，无空白闪屏、重复记分或快速 Enter 跳词", async ({
  desktopFactory,
}, testInfo) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["alpha", "beta"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `${word} connects two ideas.`,
      });
  });
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "看词选义", exact: true }).click();
  const initial = await page.locator(".practice-headword").innerText();
  const meaning = await page.evaluate(async (wordId) => {
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
        cursor: position.cursor || 0,
        mode: "meaning-choice",
        wordId,
        attemptId: position.draft.attemptId,
      })
    ).meaning;
  }, initial);
  // 只读 DOM 时间线：反馈出现到实际换题的时长，用真实 renderer 时钟观察而非固定睡眠。
  await page.evaluate((first) => {
    window.__practiceFeedbackTiming = { first, correctAt: null, nextAt: null, blanks: 0 };
    const observer = new MutationObserver(() => {
      const timing = window.__practiceFeedbackTiming;
      const stage = document.querySelector(".practice-stage");
      const headword = stage?.querySelector(".practice-headword")?.textContent?.trim();
      if (stage?.classList.contains("correct") && timing.correctAt === null)
        timing.correctAt = performance.now();
      if (timing.correctAt !== null && timing.nextAt === null) {
        if (document.querySelector(".practice-page > .empty")) timing.blanks++;
        if (headword && headword !== first) {
          timing.nextAt = performance.now();
          observer.disconnect();
        }
      }
    });
    observer.observe(document.querySelector(".practice-page"), {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class"],
    });
  }, initial);
  const right = page.locator(".meaning-choice").filter({ hasText: meaning });
  await right.click();
  await expect(page.locator(".practice-feedback")).toContainText("正确 · 已记录");
  await expect(right).toBeDisabled();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await expect(page.locator(".practice-headword")).toHaveText(initial);
  const output =
    process.env.LEXIMEET_USAGE_CAPTURE || path.join(root, "test-results/practice-usage/after");
  fs.mkdirSync(output, { recursive: true });
  await page.screenshot({
    path: path.join(output, "choice-feedback.png"),
    animations: "disabled",
    scale: "css",
  });
  await expect
    .poll(() => page.evaluate(() => window.__practiceFeedbackTiming.nextAt))
    .not.toBeNull();
  const timing = await page.evaluate(() => window.__practiceFeedbackTiming);
  expect(
    timing.nextAt - timing.correctAt,
    "结果至少保留一秒；允许一次绘制帧误差",
  ).toBeGreaterThanOrEqual(950);
  expect(timing.blanks, "换题期间不能先清空页面再显示新题").toBe(0);
  expect(personalFacts(desktop.profileDir).practice).toHaveLength(1);
  const saved = await page.evaluate(
    (wordId) => window.leximeet.desktopQuery({ kind: "detail", wordId }),
    initial,
  );
  expect(saved.familiarity.score).toBe(11);
  await testInfo.attach("actual-feedback-timing", {
    body: Buffer.from(JSON.stringify(timing, null, 2)),
    contentType: "application/json",
  });
  expect(desktop.pageErrors).toEqual([]);
});
