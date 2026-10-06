"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");

// 同尺寸、同资料的设置说明前后对照；正文采集行为由后面的领域和原生用例验证。
test("目标语境采集说明的明暗宽窄对照", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "采集与快捷键", exact: true }).click();
  const output =
    process.env.LEXIMEET_CLIPBOARD_CAPTURE || path.join(root, "test-results/clipboard-target");
  fs.mkdirSync(output, { recursive: true });
  for (const [theme, width, height] of [
    ["light", 1321, 896],
    ["dark", 820, 650],
  ]) {
    await resizeDesktop(desktop, width, height);
    if (theme === "dark")
      await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await expect(
      page.getByRole("heading", { name: "系统剪贴板与快捷键", exact: true }),
    ).toBeVisible();
    await page.screenshot({
      path: path.join(output, `settings-${theme}.png`),
      scale: "css",
      animations: "disabled",
    });
  }
});

const pending = (desktop) =>
  desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot());
const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
async function copied(desktop, text) {
  await desktop.app.evaluate(async (_electron, text) => {
    process.env.LEXIMEET_TEST_CLIPBOARD_TEXT = text;
    await globalThis.__leximeetTestCapture.poll();
  }, text);
}

test("真实词书交集：无目标和目标外静默，仅目标词通知并保存原语境", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(() =>
    window.leximeet.settings({
      clipboardCaptureEnabled: true,
      clipboardAutoCollect: false,
    }),
  );
  await copied(desktop, "Apple banana orange.");
  expect((await pending(desktop)).items).toHaveLength(0);
  const fixture = await page.evaluate(async () => {
    const current = await window.leximeet.desktopState();
    const goal = current.catalogs.find((catalog) => /ielts/i.test(catalog.catalog_id)).catalog_id;
    await window.leximeet.desktopCommand({
      action: "setGoal",
      goal,
      expectedRevision: current.profile.revision,
    });
    const pool = await window.leximeet.desktopQuery({
      scope: "catalog",
      catalogId: goal,
      limit: 100,
    });
    const inside = pool.words.filter((word) => /^[a-z]+$/.test(word.word)).slice(0, 2);
    const dictionary = await window.leximeet.desktopQuery({
      scope: "dictionary",
      offset: 50000,
      limit: 100,
    });
    const candidates = dictionary.words
      .map((row) => row.word)
      .filter((word) => /^[a-z]+$/.test(word));
    const matches = await window.leximeet.desktopQuery({
      kind: "clipboardCandidates",
      words: candidates,
    });
    const inGoal = new Set(matches.matches.map((row) => row.word.toLowerCase()));
    const outside = candidates.find((word) => !inGoal.has(word));
    if (inside.length !== 2 || !outside) throw new Error("测试需要真实目标内与词典内目标外的词");
    return { goal, inside: inside.map((word) => word.word), outside };
  });
  await copied(desktop, `${fixture.outside} outsidewordleximeet.`);
  expect((await pending(desktop)).items).toHaveLength(0);
  const expected = await page.evaluate(
    (words) => window.leximeet.desktopQuery({ kind: "clipboardCandidates", words }),
    fixture.inside,
  );
  // 用标点连接避免引入 and 等额外目标词；重复词只发一条通知。
  const original = `${fixture.inside[0].toUpperCase()}, ${fixture.outside}; ${fixture.inside[1]}, ${fixture.inside[0]}!`;
  await copied(desktop, original);
  const items = (await pending(desktop)).items;
  expect(items.map((item) => item.word)).toEqual(expected.matches.map((item) => item.word));
  await desktop.app.evaluate(
    (_electron, ids) => {
      ids.forEach((id) =>
        globalThis.__leximeetTestCapture.notification(id).emit("action", { actionIndex: 0 }),
      );
    },
    items.map((item) => item.id),
  );
  await expect.poll(async () => (await state(desktop)).insights.encounters).toBe(2);
  const records = await page.evaluate(() => window.leximeet.desktopQuery({ kind: "encounters" }));
  expect(records.encounters.every((record) => record.context === original)).toBe(true);
  expect((await state(desktop)).profile.planEnabled).toBe(false);
  // 手动采集目标外的词依然可用；它不应通过剪贴板那条目标约束。
  await page.evaluate(
    (word) =>
      window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `Manual ${word}.`,
      }),
    fixture.outside,
  );
  expect((await state(desktop)).insights.encounters).toBe(3);
});

test("切换或清除目标立即撤回待决通知，旧通知超时不能写入", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    const current = await window.leximeet.desktopState();
    await window.leximeet.desktopCommand({
      action: "setGoal",
      goal: "dictionary",
      expectedRevision: current.profile.revision,
    });
    await window.leximeet.settings({ clipboardCaptureEnabled: true });
  });
  await copied(desktop, "Apple banana.");
  expect((await pending(desktop)).items).toHaveLength(2);
  await page.evaluate(async () => {
    const current = await window.leximeet.desktopState();
    await window.leximeet.desktopCommand({
      action: "setGoal",
      goal: "",
      expectedRevision: current.profile.revision,
    });
  });
  expect((await pending(desktop)).items).toHaveLength(0);
  // 真实倒计时边界用于防止目标变更后仍有异步保存，测试窗口保持隐藏。
  await page.waitForTimeout(10500);
  expect((await state(desktop)).insights.encounters).toBe(0);
});
