"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");

const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
async function resize(desktop, width, height) {
  await resizeDesktop(desktop, width, height);
  await expect
    .poll(() => desktop.page.evaluate(() => [innerWidth, innerHeight]))
    .toEqual([width, height]);
}
async function capture(desktop, name, phase) {
  await expect
    .poll(() =>
      desktop.page.locator(".guide-final-fireworks").evaluate((canvas) =>
        canvas
          .getContext("2d")
          .getImageData(0, 0, canvas.width, canvas.height)
          .data.some((value, index) => index % 4 === 3 && value > 0),
      ),
    )
    .toBe(false);
  const directory = path.join(root, "test-results/guide-tour", phase);
  fs.mkdirSync(directory, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(directory, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
}
// 全部步骤都验证真实控件和阅读内容，避免只检查高亮框存在。
async function clearLayout(desktop, extra = "") {
  await expect
    .poll(() =>
      desktop.page.evaluate((selectors) => {
        const coach = document.querySelector(".guide-coach")?.getBoundingClientRect();
        const rings = [...document.querySelectorAll(".guide-target")];
        if (!coach || !rings.length) return false;
        const areas = [...rings, ...(selectors ? document.querySelectorAll(selectors) : [])]
          .map((node) => {
            const r = node.getBoundingClientRect();
            const main = node.closest(".d-main[data-guide-docked]");
            if (!main) return r;
            const bounds = main.getBoundingClientRect();
            return {
              left: r.left,
              right: r.right,
              top: Math.max(r.top, bounds.top),
              bottom: Math.min(r.bottom, bounds.bottom),
            };
          })
          .filter((box) => box.bottom > box.top);
        return (
          coach.left >= 14 &&
          coach.right <= innerWidth - 14 &&
          coach.top >= 62 &&
          coach.bottom <= innerHeight - 38 &&
          areas.every(
            (box) =>
              box.bottom <= 54 ||
              box.top >= innerHeight - 28 ||
              coach.left >= box.right ||
              coach.right <= box.left ||
              coach.top >= box.bottom ||
              coach.bottom <= box.top,
          )
        );
      }, extra),
    )
    .toBe(true);
}
// 记录真实 Canvas 绘制，避免短动画被轮询错过；不改变动画或业务数据。
async function trackFireworks(desktop) {
  await expect(desktop.page.locator(".guide-final-fireworks")).toBeAttached();
  await desktop.page.emulateMedia({ reducedMotion: "no-preference" });
  desktop.lastFireworks = 0;
  await desktop.page.evaluate(() => {
    window.__guideFireworks = 0;
    const context = document.querySelector(".guide-final-fireworks").getContext("2d");
    const fill = context.fill.bind(context);
    context.fill = (...args) => {
      window.__guideFireworks++;
      return fill(...args);
    };
  });
}
async function progress(desktop, count) {
  await expect.poll(async () => (await state(desktop)).guide.completed.length).toBe(count);
  await expect
    .poll(() => desktop.page.evaluate(() => window.__guideFireworks))
    .toBeGreaterThan(desktop.lastFireworks);
  desktop.lastFireworks = await desktop.page.evaluate(() => window.__guideFireworks);
}
async function checkpoint(desktop, name, theme, extra = "") {
  for (const [suffix, width, height] of [
    ["", 1321, 896],
    ["-narrow", 820, 600],
  ]) {
    await resize(desktop, width, height);
    await clearLayout(desktop, extra);
    if (name.startsWith("learn-list"))
      await expect
        .poll(() =>
          desktop.page.locator(".practice-list-scroll").evaluate((scroll) => {
            const row = scroll.querySelector("tbody tr").getBoundingClientRect();
            const header = scroll.querySelector("thead").getBoundingClientRect();
            // 反馈按钮、高亮行和表头必须完整留在当前窗口，不能靠横向滚动补看。
            return (
              scroll.scrollWidth <= scroll.clientWidth + 1 &&
              row.top >= header.bottom - 1 &&
              row.left >= 0 &&
              row.right <= innerWidth
            );
          }),
        )
        .toBe(true);
    await capture(desktop, name + suffix + "-" + theme, "after");
  }
  await resize(desktop, 1321, 896);
  await clearLayout(desktop, extra);
}
function wav(seconds = 2.4) {
  const frames = Math.round(16000 * seconds),
    buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  return buffer;
}

test("首启邀请可跳过与重开，侧边栏优先，雅思默认可更换，目标不强制启用计划", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  let page = desktop.page;
  await resize(desktop, 1321, 896);
  await expect(page.locator(".guide-invitation-card")).toBeVisible();
  await expect(page.locator(".guide-coach")).toHaveCount(0);
  await capture(desktop, "invitation-light", "after");
  const forbidden = await page.locator('[data-guide="nav-plan"]').boundingBox();
  await page.mouse.click(forbidden.x + forbidden.width / 2, forbidden.y + forbidden.height / 2);
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  page = desktop.page;
  await expect(page.locator(".guide-invitation-card, .guide-coach")).toHaveCount(0);
  await page.locator('[data-guide="nav-settings"]').click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "使用教学", exact: true })
    .click();
  await page.getByRole("button", { name: "重新开始引导教学", exact: true }).click();
  await trackFireworks(desktop);
  await page.getByRole("button", { name: "进入教学", exact: true }).click();
  await expect(page.locator(".guide-coach")).toContainText("先认识侧边栏");
  await checkpoint(desktop, "sidebar", "light");
  await page.locator(".guide-step-action button:last-child").click();
  await progress(desktop, 1);
  await expect(page.locator('.planning-catalog[aria-pressed="true"]')).toContainText("雅思");
  expect((await state(desktop)).profile.goal).toBeNull();
  const other = (await state(desktop)).catalogs.find((item) => /GMAT/.test(item.title_zh));
  await page.locator(".planning-catalog").filter({ hasText: other.title_zh }).click();
  await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await progress(desktop, 2);
  const saved = await state(desktop);
  expect(saved.profile.goal).toBeNull();
  expect(saved.profile.planEnabled).toBe(false);
  expect(saved.queue.planned).toEqual([]);
  await page.locator(".guide-step-action button:last-child").click();
  await progress(desktop, 3);
  expect((await state(desktop)).profile.planEnabled).toBe(false);
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
});

for (const theme of ["light", "dark"]) {
  test(`13 项完整教学 ${theme}：实际练习与自然音频结束，参观不制造资料，全部步骤宽窄窗无遮挡`, async ({
    desktopFactory,
  }) => {
    const profileDir = desktopFactory.newProfile();
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "audio/wav" });
      response.end(wav());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let desktop;
    try {
      desktop = await desktopFactory.start({ profileDir });
      const page = desktop.page;
      await page.evaluate(
        async ({ theme, url }) => {
          await window.leximeet.settings({ theme });
          await window.leximeet.audioSettings({
            action: "save",
            provider: "custom",
            custom: { url, method: "GET", body: "" },
          });
        },
        {
          theme,
          url: `http://127.0.0.1:${server.address().port}/audio?word={word}`,
        },
      );
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await trackFireworks(desktop);
      await resize(desktop, 1321, 896);
      await capture(desktop, "invitation-ielts-" + theme, "after");
      await page.getByRole("button", { name: "进入教学", exact: true }).click();
      await checkpoint(desktop, "sidebar-ielts", theme);
      await page.locator(".guide-step-action button:last-child").click();
      await progress(desktop, 1);
      await expect(page.locator('.planning-catalog[aria-pressed="true"]')).toContainText("雅思");
      await checkpoint(desktop, "goal-ielts", theme);
      await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
      await progress(desktop, 2);
      await checkpoint(desktop, "plan-ielts", theme);
      await page.getByRole("spinbutton", { name: "每天新学", exact: true }).fill("12");
      await page.getByRole("spinbutton", { name: "每天复习", exact: true }).fill("24");
      await expect(page.getByLabel("学习开始时间", { exact: true })).toHaveValue("08:00");
      await expect(page.getByLabel("学习结束时间", { exact: true })).toHaveValue("20:00");
      await page.getByRole("checkbox", { name: "学习提醒", exact: true }).uncheck();
      await expect(page.getByLabel("学习开始时间", { exact: true })).toHaveCount(0);
      await page.getByRole("checkbox", { name: "学习提醒", exact: true }).check();
      await page.getByLabel("学习开始时间", { exact: true }).fill("09:00");
      await page.getByLabel("学习结束时间", { exact: true }).fill("19:00");
      await page.getByRole("button", { name: "保存学习规划", exact: true }).click();
      await progress(desktop, 3);
      const saved = await state(desktop);
      expect(saved.profile).toMatchObject({
        goal: "book:qwerty:IELTS_3_T",
        planEnabled: true,
        dailyNew: 12,
        dailyReview: 24,
        reminderEnabled: true,
        studyStart: "09:00",
        studyEnd: "19:00",
      });
      await checkpoint(
        desktop,
        "learn-list-ielts",
        theme,
        ".practice-list-table thead, .practice-list-table tbody tr:first-child",
      );
      await page.getByRole("button", { name: "遮挡英文", exact: true }).click();
      await expect(page.getByRole("button", { name: "揭示英文", exact: true })).toHaveCount(12);
      await page.getByRole("button", { name: "遮挡中文", exact: true }).click();
      await page.getByRole("button", { name: "揭示中文", exact: true }).first().click();
      await checkpoint(
        desktop,
        "learn-list-revealed-ielts",
        theme,
        ".practice-list-table thead, .practice-list-table tbody tr:first-child",
      );
      await page
        .locator('[data-guide="practice-row"]')
        .getByRole("button", { name: "熟练 +1", exact: true })
        .click();
      await progress(desktop, 4);
      await checkpoint(
        desktop,
        "audio",
        theme,
        '.d-word-card > header, [data-card-module="meaning"]',
      );
      await page.getByRole("button", { name: "美式", exact: true }).click();
      await expect(page.locator(".d-statusbar")).toContainText("正在播放");
      expect((await state(desktop)).guide.completed).toHaveLength(4);
      await page.getByRole("button", { name: "英式", exact: true }).click();
      await expect(page.locator(".d-statusbar")).toContainText("正在播放");
      expect((await state(desktop)).guide.completed).toHaveLength(4);
      expect(
        await page.locator(".guide-final-fireworks").evaluate((canvas) =>
          canvas
            .getContext("2d")
            .getImageData(0, 0, canvas.width, canvas.height)
            .data.some((value, index) => index % 4 === 3 && value > 0),
        ),
      ).toBe(false);
      await progress(desktop, 5);
      await checkpoint(
        desktop,
        "practice",
        theme,
        ".practice-headword, .practice-question, .practice-instruction",
      );
      const answer = await page.locator(".practice-headword").innerText();
      const spelling = page.getByRole("textbox", { name: "练习答案" });
      if (theme === "light") {
        const recordedBefore = (await state(desktop)).insights.practice;
        await page.evaluate(async () => {
          const saved = await window.leximeet.desktopQuery({
            kind: "practice",
            scope: "library",
            mode: "copy",
          });
          const word = (
            await window.leximeet.desktopQuery({
              kind: "practiceWords",
              scope: "library",
              mode: "copy",
              offset: saved.cursor,
              limit: 1,
            })
          ).words[0];
          await window.leximeet.desktopCommand({
            action: "practiceSave",
            scope: "library",
            cursor: saved.cursor,
            wordId: word.id,
            mode: "copy",
            draft: {
              input: word.word.slice(0, 1),
              answered: true,
              attemptId: crypto.randomUUID(),
            },
          });
        });
        await page.reload();
        await trackFireworks(desktop);
        await expect(spelling).toBeEditable();
        // 显示草稿不能自报已答对。重启恢复未完成输入，不产生练习事件或跳教学。
        await expect(spelling).toHaveValue(answer.trim().slice(0, 1));
        expect((await state(desktop)).insights.practice).toBe(recordedBefore);
        expect((await state(desktop)).guide.completed).toHaveLength(5);
      }
      await expect(spelling).toBeFocused();
      await spelling.pressSequentially(theme === "light" ? answer.trim().slice(1) : answer.trim(), {
        delay: 100,
      });
      await progress(desktop, 6);
      await checkpoint(desktop, "clipboard", theme);
      const clipboardToggle = page.getByRole("checkbox", {
        name: "开启剪贴板识别",
        exact: true,
      });
      await clipboardToggle.check();
      await expect
        .poll(async () => (await state(desktop)).settings.clipboardCaptureEnabled)
        .toBe(true);
      await clipboardToggle.uncheck();
      await page.locator(".guide-step-action button:last-child").click();
      await progress(desktop, 7);
      await checkpoint(desktop, "trash-entry", theme);
      await page.locator('[data-guide="nav-trash"]').click();
      await expect(page.getByRole("heading", { name: "回收站", exact: true })).toBeVisible();
      await checkpoint(desktop, "trash-preview", theme, ".d-word-list .empty");
      await page.locator(".guide-step-action button:last-child").click();
      await progress(desktop, 8);
      for (const [id, count] of [
        ["dictionary", 9],
        ["insights", 10],
        ["theme", 11],
        ["audioSettings", 12],
        ["captureSettings", 13],
      ]) {
        await checkpoint(desktop, id, theme);
        if (id === "captureSettings") {
          const shortcut = page.getByRole("checkbox", {
            name: "遇见采集快捷键",
            exact: true,
          });
          await shortcut.check();
          await expect
            .poll(async () => (await state(desktop)).settings.globalShortcutEnabled)
            .toBe(true);
          await shortcut.uncheck();
        }
        if (["theme", "audioSettings"].includes(id)) {
          const anchor =
            id === "theme"
              ? "appearance-preview"
              : id === "audioSettings"
                ? "audio-preview"
                : "capture-preview-settings";
          expect(
            await page
              .locator(`[data-guide="${anchor}"]`)
              .evaluate((node) =>
                [...node.querySelectorAll("input,select,button")].every((control) => control.inert),
              ),
          ).toBe(true);
        }
        await page.locator(".guide-step-action button:last-child").click();
        await progress(desktop, count);
      }
      await expect(page.locator(".guide-coach, .guide-invitation-card")).toHaveCount(0);
      expect(await page.locator("[inert]").count()).toBe(0);
      const completed = await state(desktop);
      expect(completed.guide.active).toBe(false);
      expect(completed.guide.finishedAt).toBeTruthy();
      expect(completed.insights.encounters).toBe(0);
      expect(completed).not.toHaveProperty("tags");
      expect(completed.books).toEqual(saved.books);
      expect(
        (await page.evaluate(() => window.leximeet.desktopQuery({ scope: "trash" }))).total,
      ).toBe(0);
      expect(completed.settings).toEqual(saved.settings);
      expect(completed.profile).toEqual(saved.profile);
      await desktop.close();
      desktop = await desktopFactory.start({ profileDir });
      expect((await state(desktop)).guide.finishedAt).toBe(completed.guide.finishedAt);
      await expect(desktop.page.locator(".guide-coach, .guide-invitation-card")).toHaveCount(0);
    } finally {
      if (desktop && !desktop.closed) await desktop.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
}

test("空词库可跳过目标和计划，教学不创建词条，今日入口直达练习中心", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "进入教学", exact: true }).click();
  await page.locator(".guide-step-action button:last-child").click();
  await expect(page.locator(".guide-coach")).toContainText("选择学习目标");
  await page.locator(".guide-step-action button:last-child").click();
  await expect(page.locator(".guide-coach")).toContainText("安排学习节奏");
  await page.locator(".guide-step-action button:last-child").click();
  await expect(page.locator('[data-guide="practice-empty"]')).toBeVisible();
  await page.locator(".guide-step-action button:last-child").click();
  const saved = await state(desktop);
  expect(saved.profile.goal).toBeNull();
  expect(saved.profile.planEnabled).toBe(false);
  expect(saved.insights.manualWords).toBe(0);
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.locator('[data-guide="nav-today"]').click();
  await page.getByRole("button", { name: "去练习中心", exact: true }).click();
  await expect(page.getByRole("heading", { name: "练习中心", exact: true })).toBeVisible();
});
