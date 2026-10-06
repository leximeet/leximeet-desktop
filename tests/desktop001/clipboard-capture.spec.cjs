"use strict";
const { test, expect, root } = require("../helpers/electron-fixture.cjs");
const path = require("node:path");
const fs = require("node:fs");
const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
const pending = (desktop) =>
  desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot());
async function copied(desktop, text) {
  await desktop.app.evaluate(async (_electron, text) => {
    process.env.LEXIMEET_TEST_CLIPBOARD_TEXT = text;
    await globalThis.__leximeetTestCapture.poll();
  }, text);
}
async function useDictionaryGoal(page) {
  await page.evaluate(async () => {
    const current = await window.leximeet.desktopState();
    await window.leximeet.desktopCommand({
      action: "setGoal",
      goal: "dictionary",
      expectedRevision: current.profile.revision,
    });
  });
}
async function editor(desktop) {
  await expect
    .poll(() => desktop.app.windows().some((page) => page.url().endsWith("#capture-editor")))
    .toBe(true);
  const page = desktop.app.windows().find((page) => page.url().endsWith("#capture-editor"));
  await expect(page.getByRole("textbox", { name: "捕获单词" })).toBeVisible();
  return page;
}

test("显式整本词典目标逐词通知：立即接受、拒绝与真实 10 秒超时；偏好与关闭识别持久化", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await useDictionaryGoal(page);
  await page.evaluate(() => window.leximeet.settings({ clipboardCaptureEnabled: true }));
  await copied(desktop, "Alpha, beta gamma!");
  const items = (await pending(desktop)).items;
  expect(items.map((item) => item.word)).toEqual(["alpha", "beta", "gamma"]);
  const options = await desktop.app.evaluate(
    (_electron, ids) => ids.map((id) => globalThis.__leximeetTestCapture.notification(id).options),
    items.map((item) => item.id),
  );
  expect(options.map((option) => option.title)).toEqual([
    "保存 alpha 的语境？",
    "保存 beta 的语境？",
    "保存 gamma 的语境？",
  ]);
  expect(options.every((option) => option.actions.length === 2)).toBe(true);
  await desktop.app.evaluate(
    (_electron, ids) => {
      const get = (id) => globalThis.__leximeetTestCapture.notification(id);
      get(ids[0]).emit("action", { actionIndex: 0 });
      get(ids[0]).emit("click");
      get(ids[1]).emit("action", { actionIndex: 1 });
    },
    items.map((item) => item.id),
  );
  await expect.poll(async () => (await state(desktop)).insights.encounters).toBe(1);
  await expect.poll(async () => (await pending(desktop)).items.length, { timeout: 15000 }).toBe(0);
  const captured = await page.evaluate(() => window.leximeet.desktopQuery({ kind: "encounters" }));
  expect(captured.encounters.map((item) => item.word).sort()).toEqual(["alpha", "gamma"]);
  expect(captured.encounters.every((item) => item.context === "Alpha, beta gamma!")).toBe(true);
  await copied(desktop, "Alpha, beta gamma!");
  expect((await pending(desktop)).items).toEqual([]);
  await page.evaluate(() => window.leximeet.settings({ clipboardAutoCollect: false }));
  await copied(desktop, "Delta epsilon zeta.");
  await expect.poll(async () => (await pending(desktop)).items.length).toBe(3);
  await expect.poll(async () => (await pending(desktop)).items.length, { timeout: 15000 }).toBe(0);
  expect((await state(desktop)).insights.encounters).toBe(2);
  await copied(desktop, "Eta theta iota.");
  await page.evaluate(() => window.leximeet.settings({ clipboardCaptureEnabled: false }));
  expect((await pending(desktop)).items).toEqual([]);
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  expect((await state(desktop)).settings).toMatchObject({
    clipboardAutoCollect: false,
    clipboardCaptureEnabled: false,
  });
  expect((await state(desktop)).insights.encounters).toBe(2);
});

test("手动遇见与快捷键打开独立受控窗口；收起保留草稿，窄权限桥拒绝扩权", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.getByRole("button", { name: "快速记录遇见", exact: true }).click();
  let popup = await editor(desktop);
  expect(await page.getByRole("textbox", { name: "捕获单词" }).count()).toBe(0);
  await popup.getByRole("textbox", { name: "捕获单词" }).fill("serendipity");
  await popup
    .getByRole("textbox", { name: "捕获语境" })
    .fill("A serendipity encounter has its own small window.");
  const output = path.join(root, "test-results/study-capture/after");
  fs.mkdirSync(output, { recursive: true });
  await popup.screenshot({
    path: path.join(output, "capture-window-light.png"),
    scale: "css",
  });
  await popup.getByRole("button", { name: "稍后再写", exact: true }).click();
  await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.shortcut());
  popup = await editor(desktop);
  await expect(popup.getByRole("textbox", { name: "捕获语境" })).toHaveValue(
    "A serendipity encounter has its own small window.",
  );
  expect(
    await popup.evaluate(() => ({
      main: typeof window.leximeet,
      node: typeof window.require,
      process: typeof window.process,
    })),
  ).toEqual({ main: "undefined", node: "undefined", process: "undefined" });
  await expect(
    popup.evaluate(() => window.leximeetCapture.action({ action: "open" })),
  ).rejects.toThrow("不能创建其他窗口");
  await expect(
    popup.evaluate(() => window.leximeetCapture.action({ action: "save", path: "/tmp/untrusted" })),
  ).rejects.toThrow("参数无效");
  await page.evaluate(() => window.leximeet.settings({ theme: "dark" }));
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "dark");
  await popup.screenshot({
    path: path.join(output, "capture-window-dark.png"),
    scale: "css",
  });
  await popup.getByRole("button", { name: "确认保存遇见", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).insights.encounters).toBe(1);
  await page.evaluate(() =>
    window.leximeet.captureAction({
      action: "open",
      word: "alpha",
      mode: "capture",
    }),
  );
  await expect(popup.getByRole("textbox", { name: "捕获单词" })).toHaveValue("alpha");
  await expect(popup.getByRole("textbox", { name: "捕获语境" })).toHaveValue("");
  await popup.getByRole("button", { name: "稍后再写", exact: true }).click();
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
});

test("显式选择弹窗模式后使用独立窗口，每词决定可操作，关闭提醒撤回整批", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await useDictionaryGoal(page);
  await page.evaluate(() =>
    window.leximeet.settings({
      clipboardCaptureEnabled: true,
      clipboardAutoCollect: false,
      clipboardReminderMode: "popup",
    }),
  );
  await copied(desktop, "Alpha beta gamma.");
  await expect
    .poll(() => desktop.app.windows().some((win) => win.url().endsWith("#capture-inbox")))
    .toBe(true);
  const popup = desktop.app.windows().find((win) => win.url().endsWith("#capture-inbox"));
  await expect(popup.locator(".capture-notification")).toHaveCount(3);
  await expect(popup.locator(".capture-notification").first()).toContainText("到时不采集");
  await popup
    .locator(".capture-notification")
    .first()
    .getByRole("button", { name: "采集", exact: true })
    .click();
  await expect.poll(async () => (await state(desktop)).insights.encounters).toBe(1);
  await popup
    .locator(".capture-notification")
    .first()
    .getByRole("button", { name: "不采集", exact: true })
    .click();
  await expect(popup.locator(".capture-notification")).toHaveCount(1);
  await desktop.app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((win) => win.webContents.getURL().endsWith("#capture-inbox"))
      .close(),
  );
  expect((await pending(desktop)).items).toEqual([]);
  expect((await state(desktop)).insights.encounters).toBe(1);
});
