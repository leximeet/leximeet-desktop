"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

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
  const directory = path.join(root, "test-results/guide-focus", phase);
  fs.mkdirSync(directory, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(directory, name + ".png"),
    scale: "css",
    animations: "disabled",
  });
}
function wav() {
  const buffer = Buffer.alloc(44 + 3200);
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
  buffer.writeUInt32LE(3200, 40);
  return buffer;
}

test("教学聚焦：列表首行可回想，卡片可拖动，其余按钮与快捷键锁定，跳过后恢复", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await resize(desktop, 1321, 864);
  await page.getByRole("button", { name: "进入教学", exact: true }).click();
  await page.locator(".guide-step-action button:last-child").click();
  await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await page.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(page.locator(".practice-list-table tbody tr")).toHaveCount(10);
  await capture(desktop, "list-light", "after");
  await expect(page.locator(".guide-coach")).not.toContainText("定位操作位置");
  await expect(page.locator(".guide-coach-actions button")).toHaveCount(1);
  await expect(page.locator(".guide-coach-actions")).toContainText(
    "在设置的「使用教学」中可以重新进入。",
  );
  const uncovered = () =>
    page.evaluate(() => {
      const coach = document.querySelector(".guide-coach").getBoundingClientRect();
      return [
        ".practice-list-table thead",
        ".practice-list-table tbody tr:first-child",
        '[data-guide="practice-mask"]',
      ].every((selector) => {
        const box = document.querySelector(selector).getBoundingClientRect();
        return (
          coach.left >= box.right ||
          coach.right <= box.left ||
          coach.top >= box.bottom ||
          coach.bottom <= box.top
        );
      });
    });
  await expect.poll(uncovered).toBe(true);
  const original = await page.locator(".guide-coach").boundingBox();
  const handle = await page.locator(".guide-coach-heading").boundingBox();
  await page.mouse.move(handle.x + 70, handle.y + 10);
  await page.mouse.down();
  await page.mouse.move(24, 90, { steps: 12 });
  await page.mouse.up();
  const moved = await page.locator(".guide-coach").boundingBox();
  expect(Math.abs(moved.x - original.x) + Math.abs(moved.y - original.y)).toBeGreaterThan(80);
  await expect.poll(uncovered).toBe(true);
  await capture(desktop, "list-dragged-light", "after");
  const forbidden = page.locator('[data-guide="nav-settings"]');
  const outside = await forbidden.boundingBox();
  await page.mouse.click(outside.x + outside.width / 2, outside.y + outside.height / 2);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(modifier + "+,");
  await page.keyboard.press(modifier + "+k");
  await expect(page.locator(".practice-list-table")).toBeVisible();
  expect((await state(desktop)).guide.completed.length).toBe(3);
  // 非首行的反馈同样受锁定保护，只有本步圈出的首行和遮挡切换允许操作。
  const second = await page
    .locator(".practice-list-table tbody tr")
    .nth(1)
    .getByRole("button", { name: "不熟悉 −1", exact: true })
    .boundingBox();
  await page.mouse.click(second.x + second.width / 2, second.y + second.height / 2);
  expect((await state(desktop)).insights.practice).toBe(0);
  for (let index = 0; index < 8; index++) {
    await page.keyboard.press("Tab");
    expect(
      await page.evaluate(
        () =>
          !!document.activeElement.closest(
            '.guide-coach, [data-guide="practice-row"], [data-guide="practice-mask"]',
          ),
      ),
    ).toBe(true);
  }
  await resize(desktop, 820, 600);
  await expect.poll(uncovered).toBe(true);
  await capture(desktop, "list-narrow-light", "after");
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(page.locator(".guide-overlay")).toHaveCount(0);
  expect(await page.locator("[inert]").count()).toBe(0);
  await forbidden.click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "外观与词卡", exact: true })
    .click();
  await page.getByRole("combobox", { name: "主题", exact: true }).selectOption("dark");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "使用教学", exact: true })
    .click();
  await page.getByRole("button", { name: "继续引导", exact: true }).click();
  await expect(page.locator(".practice-list-table")).toBeVisible();
  await expect.poll(uncovered).toBe(true);
  await capture(desktop, "list-narrow-dark", "after");
  await page
    .locator('[data-guide="practice-row"]')
    .getByRole("button", { name: "不熟悉 −1", exact: true })
    .click();
  await expect.poll(async () => (await state(desktop)).guide.completed.length).toBe(4);
});
