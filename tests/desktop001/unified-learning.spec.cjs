"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");
const detail = (page) =>
  page.evaluate(() => window.leximeet.desktopQuery({ kind: "detail", wordId: "alpha" }));

async function capture(desktop, name) {
  // 主题切换要经过 Core 回写；确认主题已应用后再留图，避免文件名与画面不一致。
  await expect(desktop.page.locator("html")).toHaveAttribute(
    "data-theme",
    name.endsWith("dark") ? "dark" : "light",
  );
  const directory = path.join(root, "test-results/learning-standard");
  fs.mkdirSync(directory, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(directory, `${name}.png`),
    scale: "css",
    animations: "disabled",
  });
}

test("看词选义经 Core 判分，同题订正不加分，新尝试可以计分；临摹支持逐字、退格和 Enter", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "alpha",
      context: "Alpha is the first letter.",
    }),
  );
  await page.reload();
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "看词选义", exact: true }).click();
  await expect(page.locator(".meaning-choice")).toHaveCount(4);
  await page.getByRole("button", { name: "练习设置", exact: true }).click();
  await page.getByRole("checkbox", { name: "自动进入下一词" }).uncheck();
  await page.getByRole("button", { name: "练习设置", exact: true }).click();
  // 测试知道词典释义，像用户回想含义后选择；选项 ID 不携带正确答案。
  await expect(page.locator(".meaning-choice").first()).toBeEnabled();
  // 查回已经冻结的同一题；多义词不能以词典第一义项替代本题提示。
  const text = await page.evaluate(async () => {
    const position = await window.leximeet.desktopQuery({
      kind: "practice",
      scope: "library",
      mode: "meaning-choice",
      wordId: "alpha",
    });
    return (
      await window.leximeet.desktopQuery({
        kind: "practiceQuestion",
        scope: "library",
        cursor: position.cursor || 0,
        wordId: "alpha",
        mode: "meaning-choice",
        attemptId: position.draft.attemptId,
      })
    ).meaning;
  });
  expect(text).toBeTruthy();
  const right = page.locator(".meaning-choice").filter({ hasText: text });
  const wrong = page.locator(".meaning-choice").filter({ hasNotText: text }).first();
  await wrong.click();
  await expect(page.locator(".practice-feedback")).toContainText("再回想");
  await right.click();
  await expect(page.locator(".practice-feedback")).toContainText("已记录");
  expect((await detail(page)).familiarity.score).toBe(9);
  await page.getByRole("button", { name: "再练一次", exact: true }).click();
  await right.click();
  await expect.poll(async () => (await detail(page)).familiarity.score).toBe(10);
  await capture(desktop, "choice-light");
  await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await capture(desktop, "choice-dark");
  await resizeDesktop(desktop, 820, 600);
  await capture(desktop, "choice-narrow-dark");
  await resizeDesktop(desktop, 1321, 896);
  await page.getByRole("button", { name: "切换明亮主题", exact: true }).click();
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  const field = page.getByRole("textbox", { name: "练习答案" });
  await field.pressSequentially("alpX");
  await expect(page.locator(".spelling-letters .typed")).toHaveCount(3);
  await expect(page.locator(".spelling-letters .wrong")).toHaveCount(1);
  await field.press("Backspace");
  await field.pressSequentially("ha");
  await expect(page.locator(".spelling-letters .typed")).toHaveCount(5);
  await expect(page.locator(".spelling-letters .wrong")).toHaveCount(0);
  await capture(desktop, "copy-light");
  await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await capture(desktop, "copy-dark");
  await resizeDesktop(desktop, 820, 600);
  await expect
    .poll(() =>
      page.locator(".d-main").evaluate((main) => main.scrollWidth <= main.clientWidth + 1),
    )
    .toBe(true);
  await capture(desktop, "copy-narrow-dark");
  await expect(page.locator(".practice-feedback")).toContainText("已记录");
  expect((await detail(page)).familiarity.score).toBe(11);
  await field.press("Enter");
  await expect(page.getByRole("heading", { name: "已完成本轮练习", exact: true })).toBeVisible();
});

test("教学可返回已完成步骤，高亮不贴窗边，回看不清除目标或重复创建事实", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "进入教学", exact: true }).click();
  for (const box of await page.locator(".guide-target").all()) {
    const r = await box.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    expect(r.x).toBeGreaterThanOrEqual(9);
    expect(r.y).toBeGreaterThanOrEqual(58);
    expect(r.x + r.width).toBeLessThanOrEqual(viewport.width - 9);
    expect(r.y + r.height).toBeLessThanOrEqual(viewport.height - 36);
  }
  await page.locator(".guide-step-action button:last-child").click();
  await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await expect(page.locator(".guide-coach")).toContainText("安排学习节奏");
  const before = await page.evaluate(() => window.leximeet.desktopState());
  await page.locator(".guide-coach").getByRole("button", { name: "上一步", exact: true }).click();
  await expect(page.locator(".guide-coach")).toContainText("选择学习目标");
  await page.locator(".guide-coach").getByRole("button", { name: "上一步", exact: true }).click();
  await expect(page.locator(".guide-coach")).toContainText("先认识侧边栏");
  await page.locator(".guide-step-action button:last-child").click();
  await page.locator(".guide-step-action button:last-child").click();
  await expect(page.locator(".guide-coach")).toContainText("安排学习节奏");
  const after = await page.evaluate(() => window.leximeet.desktopState());
  expect(after.profile).toEqual(before.profile);
  expect(after.guide.completed).toEqual(before.guide.completed);
  expect(after.guide.advancedAt).toEqual(before.guide.advancedAt);
});

test("临摹加一分与默写加两分，各自连续下一词，真实按键录音可离线解码", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["alpha", "bravo"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `I encountered ${word} today.`,
      });
    window.__keyAudio = [];
    const original = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const source = original.call(this),
        start = source.start.bind(source);
      source.start = (...args) => {
        window.__keyAudio.push({
          frames: source.buffer.length,
          duration: source.buffer.duration,
        });
        return start(...args);
      };
      return source;
    };
  });
  await page.locator('[data-guide="nav-practice"]').click();
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  const first = (await page.locator(".spelling-letters").innerText()).trim();
  await capture(desktop, "copy-idle-light");
  const field = page.getByRole("textbox", { name: "练习答案" });
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();
  await field.pressSequentially(first, { delay: 35 });
  await expect
    .poll(() =>
      page.evaluate(
        async (word) =>
          (await window.leximeet.desktopQuery({ kind: "detail", wordId: word })).familiarity.score,
        first,
      ),
    )
    .toBe(11);
  await expect(page.locator(".spelling-letters")).not.toHaveText(first);
  await expect(field).toBeFocused();
  expect(
    await page.evaluate(() =>
      window.__keyAudio.some((item) => item.frames > 1000 && item.duration < 0.3),
    ),
  ).toBe(true);
  const second = (await page.locator(".spelling-letters").innerText()).trim();
  await page.getByRole("tab", { name: "单词默写", exact: true }).click();
  // pressSequentially 不等待可编辑状态；切换会落盘草稿并重建输入，须等实际就绪。
  await expect(page.getByRole("tab", { name: "单词默写", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(field).toBeEnabled();
  await expect(field).toBeFocused();
  // 默写首次打开从自己的第一词开始，不能沿用临摹已经前进的第二词。
  await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 /");
  await field.pressSequentially(first, { delay: 35 });
  await expect
    .poll(() =>
      page.evaluate(
        async (word) =>
          (await window.leximeet.desktopQuery({ kind: "detail", wordId: word })).familiarity.score,
        first,
      ),
    )
    .toBe(13);
  await expect(page.locator(".practice-stage .eyebrow")).toContainText("2 /");
  await expect(field).toBeEditable();
  await expect(field).toBeFocused();
  await field.pressSequentially(second, { delay: 35 });
  await expect
    .poll(() =>
      page.evaluate(
        async (word) =>
          (await window.leximeet.desktopQuery({ kind: "detail", wordId: word })).familiarity.score,
        second,
      ),
    )
    .toBe(12);
  await expect(page.getByRole("heading", { name: "已完成本轮练习", exact: true })).toBeVisible();
  expect(desktop.pageErrors).toEqual([]);
});
