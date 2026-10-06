"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const fs = require("node:fs");
const path = require("node:path");

const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
async function refresh(desktop) {
  await desktop.page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await desktop.page.getByRole("button", { name: "切换明亮主题", exact: true }).click();
}
async function resize(desktop, width, height) {
  await resizeDesktop(desktop, width, height);
}
async function capture(desktop, name, phase) {
  if (name.endsWith("light") || name.endsWith("dark")) {
    await expect(desktop.page.locator("html")).toHaveAttribute(
      "data-theme",
      name.endsWith("dark") ? "dark" : "light",
    );
  }
  // 截图等待真实烟花自然结束，保留稳定的排版；动画本身由完整教学场景另验。
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
  const directory = path.join(root, "test-results/desktop-ui-001", phase);
  fs.mkdirSync(directory, { recursive: true });
  await desktop.page.screenshot({
    path: path.join(directory, `${name}.png`),
    scale: "css",
    animations: "disabled",
  });
}

test("桌面布局真实窗口：保留同尺寸的引导、今日、词库与明暗窄窗对照", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start();
  await expect.poll(async () => (await state(desktop)).dictionary.entryCount).toBe(117902);
  await expect(desktop.page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await resize(desktop, 1321, 864);
  const phase = process.env.LEXIMEET_UI_CAPTURE === "before" ? "before" : "after";
  await capture(desktop, "welcome-light", phase);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(desktop.page.locator(".guide-overlay")).toHaveCount(0);
  await refresh(desktop);
  await capture(desktop, "today-light", phase);
  await desktop.page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await capture(desktop, "today-dark", phase);
  await desktop.page.getByRole("button", { name: "切换明亮主题", exact: true }).click();
  await desktop.page.evaluate(async () => {
    await window.leximeet.desktopCommand({
      action: "capture",
      word: "serendipity",
      context: "A small desktop moment of serendipity.",
    });
  });
  await desktop.page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: "我的词库", exact: true })
    .click();
  await expect(desktop.page.locator(".word-table tbody tr")).toHaveCount(1);
  await desktop.page.locator(".word-table tbody tr").first().click();
  await expect(
    desktop.page.getByRole("heading", { name: "serendipity", exact: true }),
  ).toBeVisible();
  await capture(desktop, "library-light", phase);
  await resize(desktop, 820, 728);
  await capture(desktop, "library-narrow", phase);
  await resize(desktop, 1321, 864);
  await nav(desktop, "学习规划");
  if (phase === "after")
    await expect
      .poll(
        async () =>
          (
            await desktop.page
              .getByRole("button", { name: "设置学习规划", exact: true })
              .boundingBox()
          ).height,
      )
      .toBeLessThan(45);
  await capture(desktop, "plan-light", phase);
  await nav(desktop, "词库中心");
  await capture(desktop, "dictionary-light", phase);
  await nav(desktop, "练习中心");
  await expect(desktop.page.locator(".practice-list-table")).toBeVisible();
  await capture(desktop, "practice-light", phase);
  await nav(desktop, "遇见记录");
  await expect(desktop.page.locator(".encounter-list li")).toHaveCount(1);
  await capture(desktop, "encounters-light", phase);
  await desktop.page.getByRole("button", { name: "记录新的遇见", exact: true }).click();
  await capture(desktop, "capture-light", phase);
  await expect
    .poll(() => desktop.app.windows().some((win) => win.url().endsWith("#capture-editor")))
    .toBe(true);
  const popup = desktop.app.windows().find((win) => win.url().endsWith("#capture-editor"));
  await popup.getByRole("button", { name: "稍后再写", exact: true }).click();
  await desktop.page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await capture(desktop, "settings-light", phase);
  expect(desktop.pageErrors).toEqual([]);
});

const command = (desktop, payload) =>
  desktop.page.evaluate((data) => window.leximeet.desktopCommand(data), payload);
async function nav(desktop, name) {
  await desktop.page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: false })
    .click();
}
async function settingsPanel(desktop, name) {
  await desktop.page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: "设置", exact: true })
    .click();
  await desktop.page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function aligned(desktop, anchorName) {
  // 验证真实控件、批注与 SVG 箭头的几何关系；不能只验证页面上有一个浮窗。
  await expect
    .poll(() =>
      desktop.page.evaluate((name) => {
        const target = [...document.querySelectorAll('[data-guide="' + name + '"]')].find(
          (node) => {
            const r = node.getBoundingClientRect();
            return r.width && r.height && r.top >= 54 && r.bottom <= innerHeight - 28;
          },
        );
        const coach = document.querySelector(".guide-coach");
        const ring = document.querySelector(".guide-target");
        const line = document.querySelector(".guide-connector > path");
        if (!target || !coach || !ring || !line) return false;
        const t = target.getBoundingClientRect(),
          c = coach.getBoundingClientRect(),
          r = ring.getBoundingClientRect();
        const coordinates = line
          .getAttribute("d")
          .match(/-?\d+(?:\.\d+)?/g)
          ?.map(Number);
        if (!coordinates || coordinates.length < 4) return false;
        const [x, y] = coordinates.slice(-2);
        const onEdge =
          Math.min(
            Math.abs(x - r.left),
            Math.abs(x - r.right),
            Math.abs(y - r.top),
            Math.abs(y - r.bottom),
          ) < 2;
        const uncovered =
          c.left >= t.right || c.right <= t.left || c.top >= t.bottom || c.bottom <= t.top;
        const atCenter = document.elementFromPoint(t.left + t.width / 2, t.top + t.height / 2);
        return (
          Math.abs(r.left - Math.max(9, t.left + (target.matches(".planning-body") ? 11 : -5))) <
            2 &&
          Math.abs(r.top - Math.max(58, t.top + (target.matches(".planning-body") ? 5 : -5))) < 2 &&
          onEdge &&
          uncovered &&
          c.left >= 14 &&
          c.right <= innerWidth - 14 &&
          c.top >= 62 &&
          c.bottom <= innerHeight - 38 &&
          (atCenter === target || target.contains(atCenter))
        );
      }, anchorName),
    )
    .toBe(true);
}

test("批注真正指向控件，缩放与滚动重新定位，跳过续接和设置重开保留个人资料", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  await expect(desktop.page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await resize(desktop, 1321, 864);
  await expect(desktop.page.locator(".guide-invitation-card")).toBeVisible();
  await desktop.page.getByRole("button", { name: "进入教学", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).guide.completed).toEqual([]);
  await expect(desktop.page.locator(".guide-coach")).toContainText("先认识侧边栏");
  await desktop.page.locator(".guide-step-action button:last-child").click();
  await expect(
    desktop.page.getByRole("heading", {
      name: "学习规划",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  await aligned(desktop, "guide-goal-choice");
  await capture(desktop, "guide-goal-light", "after");
  // 教学期间点其他导航没有效果；跳过后才能更改外观，再从入口续接。
  const blocked = await desktop.page.locator('[data-guide="nav-library"]').boundingBox();
  await desktop.page.mouse.click(blocked.x + blocked.width / 2, blocked.y + blocked.height / 2);
  await expect(
    desktop.page.getByRole("heading", {
      name: "学习规划",
      exact: true,
      level: 1,
    }),
  ).toBeVisible();
  expect((await state(desktop)).guide.completed).toEqual(["sidebar"]);
  await resize(desktop, 820, 600);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await desktop.page.getByRole("button", { name: "切换黑暗主题", exact: true }).click();
  await desktop.page.getByRole("button", { name: "使用教学", exact: true }).click();
  await aligned(desktop, "guide-goal-choice");
  await capture(desktop, "guide-goal-narrow-dark", "after");
  await desktop.page.locator(".d-main").evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await aligned(desktop, "guide-goal-choice");
  await expect(desktop.page.locator(".guide-coach")).not.toContainText("定位操作位置");
  await command(desktop, {
    action: "collect",
    word: "serendipity",
    note: "重新开始教学仍保留的资料",
  });
  await desktop.page.locator(".guide-coach-actions button").focus();
  await desktop.page.keyboard.press("Escape");
  await expect(desktop.page.getByRole("dialog", { name: "首次使用引导" })).toHaveCount(0);
  await expect(desktop.page.getByRole("button", { name: "使用教学", exact: true })).toBeFocused();
  expect((await state(desktop)).guide.completed).toEqual(["sidebar"]);
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  await expect(desktop.page.locator(".desktop-shell")).toBeVisible();
  await expect(desktop.page.locator(".guide-overlay")).toHaveCount(0);
  expect((await state(desktop)).guide.active).toBe(false);
  await settingsPanel(desktop, "使用教学");
  await expect(desktop.page.getByRole("progressbar", { name: "教学进度" })).toHaveAttribute(
    "value",
    "1",
  );
  await desktop.page.getByRole("button", { name: "继续引导", exact: true }).click();
  await aligned(desktop, "guide-goal-choice");
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await settingsPanel(desktop, "使用教学");
  await capture(desktop, "teaching-settings-dark", "after");
  await desktop.page.getByRole("button", { name: "重新开始引导教学", exact: true }).click();
  await expect(desktop.page.locator(".guide-invitation-card")).toBeVisible();
  expect((await state(desktop)).guide.completed).toEqual([]);
  const saved = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ scope: "manual", search: "serendipity" }),
  );
  expect(saved.words[0].note).toBe("重新开始教学仍保留的资料");
  expect((await state(desktop)).insights.manualWords).toBe(1);
});

test("桌面快捷键、列表上下键和跨页面笔记草稿；设置分栏保留未保存的发音输入", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  const page = desktop.page;
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  // 首启邀请与教学遮罩是两个状态；确认邀请已退出再发送快捷键。
  await expect(page.locator(".guide-invitation-card")).toHaveCount(0);
  await expect(page.locator(".guide-overlay")).toHaveCount(0);
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(modifier + "+k");
  await expect(page.getByRole("textbox", { name: "搜索单词" })).toBeFocused();
  await expect(page.getByRole("heading", { name: "本地词典", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "搜索单词" }).fill("serendipity");
  await expect(page.locator(".word-table tbody tr")).toHaveCount(1);
  await page.locator(".word-table tbody tr").click();
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await page
    .getByRole("textbox", { name: "我的笔记", exact: true })
    .fill("跨页面保留但尚未保存的草稿");
  await page.keyboard.press(modifier + "+1");
  await expect(page.getByRole("heading", { name: "今日学习", exact: true })).toBeVisible();
  await page.keyboard.press(modifier + "+k");
  await expect(page.getByRole("textbox", { name: "搜索单词" })).toHaveValue("serendipity");
  await expect(page.getByRole("textbox", { name: "我的笔记", exact: true })).toHaveValue(
    "跨页面保留但尚未保存的草稿",
  );
  const query = await page.evaluate(() =>
    window.leximeet.desktopQuery({
      scope: "dictionary",
      search: "serendipity",
    }),
  );
  expect(query.words[0].note).not.toBe("跨页面保留但尚未保存的草稿");
  await page.getByRole("textbox", { name: "搜索单词" }).fill("");
  await expect(page.locator(".word-table tbody tr")).toHaveCount(40);
  const rows = page.locator(".word-table tbody tr");
  await rows.first().click();
  await rows.first().focus();
  // 多选框是第一列；读取语义单词列，仍以真实方向键验证焦点与阅读同步。
  const nextWord = await rows.nth(1).locator(".word-column").innerText();
  expect(nextWord).not.toBe("");
  await page.keyboard.press("ArrowDown");
  await expect(rows.nth(1)).toBeFocused();
  await expect(page.locator(".d-word-card h2")).toHaveText(nextWord);
  await page.keyboard.press("ArrowUp");
  await expect(rows.first()).toBeFocused();
  await page.keyboard.press(modifier + "+,");
  await expect(page.getByRole("heading", { name: "设置", exact: true })).toBeVisible();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "发音", exact: true })
    .click();
  await page.getByRole("combobox", { name: "发音提供者" }).selectOption("custom");
  await page
    .getByRole("textbox", { name: "自定义 API 地址" })
    .fill("https://example.test/audio?text={word}");
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "使用教学", exact: true })
    .click();
  await page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "发音", exact: true })
    .click();
  await expect(page.getByRole("textbox", { name: "自定义 API 地址" })).toHaveValue(
    "https://example.test/audio?text={word}",
  );
  const audio = await page.evaluate(() => window.leximeet.audioSettings({ action: "get" }));
  expect(audio.provider).toBe("youdao");
  expect(audio.custom.url).not.toBe("https://example.test/audio?text={word}");
  await settingsPanel(desktop, "外观与词卡");
  await expect(page.getByRole("button", { name: /适中.*默认推荐/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await resize(desktop, 1321, 864);
  await capture(desktop, "settings-keyboard-light", "after");
  expect(desktop.pageErrors).toEqual([]);
});
