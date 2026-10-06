"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, resizeDesktop } = require("../helpers/electron-fixture.cjs");
// 页面与真实 Core 联通；不拦截 IPC，不触碰系统键鼠或用户浏览器目录。
test("插件连接设置读取真实发现状态，免输码、明暗主题窄窗不越界", async ({ desktop }, testInfo) => {
  const directory =
    process.env.LEXIMEET_CONNECTION_VISUAL_DIR || testInfo.outputPath("connection-visual");
  fs.mkdirSync(directory, { recursive: true });
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.locator('[data-guide="nav-settings"]').click();
  const nav = page.getByRole("navigation", { name: "设置分类" });
  await nav.getByRole("button", { name: "插件连接", exact: true }).click();
  const section = page.getByRole("region", { name: "插件连接设置" });
  await expect(section.getByText("本机服务就绪", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "检查可连接的插件" })).toBeVisible();
  await expect(section.getByText("等待插件出现", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: "生成配对码", exact: true })).toHaveCount(0);
  await expect(section.getByRole("textbox")).toHaveCount(0);
  await section.getByRole("button", { name: "检查可连接的插件" }).click();
  await expect(section.getByText("还没有插件连接这台电脑", { exact: true })).toBeVisible();
  const state = await page.evaluate(() => window.leximeet.connectionSettings({ action: "state" }));
  expect(state.registration.isolated).toBe(true);
  expect(state.transport.running).toBe(true);
  expect(JSON.stringify(state)).not.toMatch(
    /descriptorPath|transportKey|sessionToken|pairingSecret/,
  );
  for (const theme of ["light", "dark"]) {
    await nav.getByRole("button", { name: "外观与词卡", exact: true }).click();
    await page.getByRole("combobox", { name: "主题", exact: true }).selectOption(theme);
    await nav.getByRole("button", { name: "插件连接", exact: true }).click();
    for (const [width, height] of [
      [1321, 864],
      [820, 600],
    ]) {
      await resizeDesktop(desktop, width, height);
      await expect
        .poll(() => page.evaluate(() => [innerWidth, innerHeight]))
        .toEqual([width, height]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      await expect(section.getByRole("button", { name: "检查可连接的插件" })).toBeVisible();
      await page.screenshot({
        path: path.join(directory, `after-${theme}-${width}.png`),
        scale: "css",
        animations: "disabled",
      });
    }
  }
});
