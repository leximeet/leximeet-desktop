"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");

test("后台隔离：窗口激活、通知点击和系统设置不能打断操作者，DOM 键盘仍正常", async ({
  desktop,
}) => {
  const { page, app } = desktop;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  const denied = await page.evaluate(async () => {
    try {
      await window.leximeet.desktopAction({
        action: "openNotificationSettings",
      });
    } catch (error) {
      return error.message;
    }
  });
  if (process.platform === "darwin") expect(denied).toMatch(/后台自动测试禁止/);
  // 故意尝试所有已有激活入口；保护层必须在调用发生时阻止，不能事后抢回用户焦点。
  await app.evaluate(({ app, BrowserWindow }, mainWindowId) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.id === mainWindowId);
    win.show();
    win.showInactive();
    win.focus();
    win.restore();
    win.setFocusable(true);
    win.webContents.setAudioMuted(false);
    app.emit("activate");
    app.emit("second-instance");
    app.focus();
    if (process.platform === "darwin") app.setActivationPolicy("regular");
  }, desktop.mainWindowId);
  await page.locator('[data-guide="nav-library"]').click();
  const search = page.getByPlaceholder("搜索单词或释义…");
  await search.fill("apple");
  await search.press("ControlOrMeta+A");
  await search.pressSequentially("orange");
  await expect(search).toHaveValue("orange");
  const guard = await app.evaluate(() => globalThis.__leximeetTestBackground.snapshot());
  expect(guard.violations).toEqual([]);
  expect(guard.blocked).toMatchObject({
    "window.show": 1,
    "window.showInactive": 1,
    "window.focus": 1,
    "window.restore": 1,
    "window.setFocusable": 1,
    "audio.unmute": 1,
  });
});
