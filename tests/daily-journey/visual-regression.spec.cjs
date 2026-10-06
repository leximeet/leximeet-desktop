"use strict";
const {
  test,
  expect,
  requireExecutable,
  resizeDesktop,
} = require("../helpers/electron-fixture.cjs");
const { attachJson } = require("../helpers/journey-evidence.cjs");

const before = process.env.LEXIMEET_JOURNEY_VISUAL_BEFORE === "1";
const executable = process.env.LEXIMEET_JOURNEY_EXECUTABLE
  ? requireExecutable(process.env.LEXIMEET_JOURNEY_EXECUTABLE, "LEXIMEET_JOURNEY_EXECUTABLE")
  : undefined;

// 同一真实词条、同一窗口尺寸留前后图；不向页面塞入伪造 Markdown。
for (const [theme, width, height] of [
  ["light", 1321, 896],
  ["dark", 820, 760],
]) {
  test(`完整词条和采集偏好的真实排版：${theme} ${width}×${height}`, async ({
    desktopFactory,
  }, info) => {
    const desktop = await desktopFactory.start({
      executablePath: executable,
      poisonHostJava: !!executable,
    });
    const page = desktop.page;
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await resizeDesktop(desktop, width, height);
    if (theme === "dark")
      await page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    await page.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "capture",
        word: "government",
        context: "The government announced a policy for public education.",
      }),
    );
    await page.locator('[data-guide="nav-library"]').click();
    await page.getByRole("row").filter({ hasText: "government" }).click();
    await page.getByRole("tab", { name: "释义", exact: true }).click();
    await page.getByRole("button", { name: /^展开完整词条/ }).click();
    const meaning = page.getByRole("tabpanel", { name: "释义", exact: true });
    await page.locator(".extra-evidence").scrollIntoViewIfNeeded();
    const raw = await page.evaluate(() =>
      window.leximeet.desktopQuery({ kind: "detail", wordId: "government" }),
    );
    await attachJson(info, `government-${before ? "before" : "after"}-${theme}-source`, raw.entry);
    await info.attach(`government-${before ? "before" : "after"}-${theme}`, {
      body: await page.screenshot({ animations: "disabled", scale: "css" }),
      contentType: "image/png",
    });
    if (!before) {
      // 真实源材料必须含 Markdown；否则此测试不会证明修复了源格式显示。
      expect(JSON.stringify(raw.entry)).toMatch(/###/);
      await expect(meaning).not.toContainText("###");
      await expect(meaning.locator(".readable-text :is(h4,h5,h6)").first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "采集与快捷键", exact: true }).click();
    if (!before) {
      await expect(page.getByRole("checkbox", { name: "脱敏采集", exact: true })).toBeChecked();
      await expect(page.getByRole("combobox", { name: "重复语境不采集", exact: true })).toHaveValue(
        "7",
      );
      await expect(page.getByRole("spinbutton", { name: "语境最大长度", exact: true })).toHaveValue(
        "500",
      );
      // 把末项真实滚入视口，窄屏截图不能只留下被底栏裁掉的输入框。
      await page
        .getByRole("spinbutton", { name: "语境最大长度", exact: true })
        .scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
    }
    await info.attach(`capture-settings-${before ? "before" : "after"}-${theme}`, {
      body: await page.screenshot({ animations: "disabled", scale: "css" }),
      contentType: "image/png",
    });
  });
}
