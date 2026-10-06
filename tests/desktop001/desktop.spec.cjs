"use strict";
const { test, expect, root, resizeDesktop } = require("../helpers/electron-fixture.cjs");
const path = require("node:path");
const fs = require("node:fs");
const { dictionarySource } = require("../helpers/dictionary-source.cjs");

const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
const command = (desktop, payload) =>
  desktop.page.evaluate((data) => window.leximeet.desktopCommand(data), payload);
const query = (desktop, payload) =>
  desktop.page.evaluate((data) => window.leximeet.desktopQuery(data), payload);
async function ready(desktop) {
  await expect.poll(async () => (await state(desktop)).dictionary.entryCount).toBe(117902);
  // 未完成的批注会续接到对应页面，启动就绪不再要求固定停留在首页。
  await expect(desktop.page.locator(".desktop-shell")).toBeVisible();
}
async function nav(desktop, name) {
  await desktop.page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: false })
    .click();
}
test("真实 Main/Core/UI：普通个人资料重启持久化，当前版本暂不开放导入导出", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  try {
    await ready(desktop);
    const page = desktop.page;
    await expect(page.locator(".guide-invitation-card")).toBeVisible();
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await expect.poll(async () => (await state(desktop)).guide.active).toBe(false);
    await command(desktop, {
      action: "capture",
      word: "serendipity",
      context: "I found this book by serendipity.",
    });
    await command(desktop, {
      action: "collect",
      word: "a-private-manual-phrase",
      note: "自己的理解",
    });
    const prior = await state(desktop);
    await page.locator('[data-guide="nav-settings"]').click();
    await page
      .getByRole("navigation", { name: "设置分类" })
      .getByRole("button", { name: "本机数据", exact: true })
      .click();
    await expect(page.getByRole("button", { name: /导出完整备份|从备份恢复/ })).toHaveCount(0);
    await expect(
      page.getByText("学习资料保存在本机，导入和导出将在后续版本开放。", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.evaluate(() => window.leximeet.desktopAction({ action: "exportArchive" })),
    ).rejects.toThrow("后续版本开放");
    await expect(
      page.evaluate(() => window.leximeet.desktopAction({ action: "restoreArchive" })),
    ).rejects.toThrow("后续版本开放");
    expect(
      (await page.evaluate(() => window.leximeet.runtime())).capabilities.fileBackups.status,
    ).toBe("unsupported");
    await desktop.close();
    desktop = await desktopFactory.start({ profileDir });
    await ready(desktop);
    const restored = await state(desktop);
    expect(restored.guide.active).toBe(false);
    expect(restored.guide.completed).toEqual([]);
    expect(restored.insights.encounters).toBe(prior.insights.encounters);
    expect(restored.insights.manualWords).toBe(prior.insights.manualWords);
    expect((await query(desktop, { kind: "encounters" })).encounters[0].context).toBe(
      "I found this book by serendipity.",
    );
    expect(
      (
        await query(desktop, {
          scope: "manual",
          search: "a-private-manual-phrase",
        })
      ).words[0].note,
    ).toBe("自己的理解");
  } finally {
    if (desktop && !desktop.closed) await desktop.close();
  }
});

test("六种练习按指定顺序，独立游标与草稿跨重启保存，未提交不改变记忆", async ({
  desktopFactory,
}) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  await ready(desktop);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await command(desktop, {
    action: "setGoal",
    goal: "dictionary",
    expectedRevision: 1,
  });
  await desktop.page.reload();
  await nav(desktop, "练习中心");
  const page = desktop.page;
  await expect(page.getByRole("tab")).toHaveText([
    "单词列表",
    "看词选义",
    "单词临摹",
    "单词默写",
    "听音辨词",
    "语境填空",
  ]);
  await expect(page.getByRole("button", { name: "揭示中文", exact: true })).toHaveCount(12);
  await page.getByRole("button", { name: "遮挡英文", exact: true }).click();
  await expect(page.getByRole("button", { name: "揭示英文", exact: true })).toHaveCount(12);
  await page.getByRole("tab", { name: "单词临摹" }).click();
  await page.getByRole("button", { name: "练习设置", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "自动进入下一词" })).toBeChecked();
  await page.getByRole("textbox", { name: "练习答案" }).fill("unfinished-draft");
  await page.getByRole("tab", { name: "单词默写" }).click();
  await page.getByRole("textbox", { name: "练习答案" }).fill("another-draft");
  await page.getByRole("tab", { name: "单词临摹" }).click();
  await expect(page.getByRole("textbox", { name: "练习答案" })).toHaveValue("unfinished-draft");
  const modes = ["单词列表", "看词选义", "单词临摹", "单词默写", "听音辨词", "语境填空"];
  for (const label of modes) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator(label === "单词列表" ? ".practice-list-table" : ".practice-stage .eyebrow"),
    ).toBeVisible();
  }
  await page.getByRole("tab", { name: "单词临摹" }).click();
  await page.getByRole("button", { name: "下一词", exact: true }).click();
  await expect(page.locator(".practice-stage .eyebrow")).toContainText("2 /");
  await page.getByRole("textbox", { name: "练习答案" }).fill("second-word-draft");
  await nav(desktop, "今日学习");
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  await ready(desktop);
  await nav(desktop, "练习中心");
  await expect(desktop.page.locator(".practice-stage .eyebrow")).toContainText("2 /");
  await expect(desktop.page.getByRole("textbox", { name: "练习答案" })).toHaveValue(
    "second-word-draft",
  );
  const resumedPage = desktop.page;
  // 临摹已到第二词，默写仍停在自己的第一词，重启不能把两种游标揉成一个。
  await resumedPage.getByRole("tab", { name: "单词默写", exact: true }).click();
  await expect(resumedPage.locator(".practice-stage .eyebrow")).toContainText("1 /");
  await expect(resumedPage.getByRole("textbox", { name: "练习答案" })).toHaveValue("another-draft");
  await resumedPage.getByRole("tab", { name: "单词临摹", exact: true }).click();
  await expect(resumedPage.locator(".practice-stage .eyebrow")).toContainText("2 /");
  await expect(resumedPage.getByRole("textbox", { name: "练习答案" })).toHaveValue(
    "second-word-draft",
  );
  await resumedPage.getByRole("combobox", { name: "练习范围" }).selectOption("dictionary");
  await expect(resumedPage.getByRole("region", { name: "切换练习范围确认" })).toBeVisible();
  await resumedPage.getByRole("button", { name: "继续当前范围", exact: true }).click();
  await expect(resumedPage.getByRole("textbox", { name: "练习答案" })).toHaveValue(
    "second-word-draft",
  );
  await resumedPage.getByRole("combobox", { name: "练习范围" }).selectOption("dictionary");
  await resumedPage.screenshot({
    path: path.join(root, "test-results/desktop-001/after/practice-range-confirm.png"),
    scale: "css",
  });
  await resumedPage.getByRole("button", { name: "保存并切换", exact: true }).click();
  await expect(resumedPage.getByRole("tab", { name: "单词临摹", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(resumedPage.locator(".practice-stage .eyebrow")).toContainText("1 /");
  await expect(resumedPage.getByRole("textbox", { name: "练习答案" })).toHaveValue("");
  await resumedPage.getByRole("tab", { name: "单词列表", exact: true }).click();
  await expect(resumedPage.locator(".practice-list-table tbody tr")).toHaveCount(12);
  await resumedPage.getByRole("tab", { name: "单词临摹", exact: true }).click();
  await expect(resumedPage.locator(".practice-stage .eyebrow")).toContainText("1 /");
  await resumedPage.getByRole("combobox", { name: "练习范围" }).selectOption("library");
  await resumedPage.getByRole("button", { name: "保存并切换", exact: true }).click();
  await expect(resumedPage.locator(".practice-stage .eyebrow")).toContainText("2 /");
  await expect(resumedPage.getByRole("textbox", { name: "练习答案" })).toHaveValue(
    "second-word-draft",
  );
  expect((await state(desktop)).insights.learned).toBe(0);
  expect((await query(desktop, { kind: "encounters" })).total).toBe(0);
  await desktop.close();
});

test("首次引导暂停与重启续接；减少动态效果时完成进度仍保存", async ({ desktopFactory }) => {
  const profileDir = desktopFactory.newProfile();
  let desktop = await desktopFactory.start({ profileDir });
  await ready(desktop);
  await desktop.page.emulateMedia({ reducedMotion: "reduce" });
  await desktop.page.getByRole("button", { name: "进入教学", exact: true }).click();
  await desktop.page.locator(".guide-step-action button:last-child").click();
  await desktop.page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).guide.completed.length).toBe(2);
  const pixels = await desktop.page.locator(".guide-final-fireworks").evaluate((canvas) =>
    canvas
      .getContext("2d")
      .getImageData(0, 0, canvas.width, canvas.height)
      .data.some((value, index) => index % 4 === 3 && value > 0),
  );
  expect(pixels).toBe(false);
  await desktop.page.getByRole("button", { name: "暂停引导", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).guide.active).toBe(false);
  await desktop.close();
  desktop = await desktopFactory.start({ profileDir });
  await ready(desktop);
  await desktop.page.getByRole("button", { name: "使用教学", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).guide.active).toBe(true);
  expect((await state(desktop)).guide.completed).toHaveLength(2);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(desktop.page.locator(".guide-overlay")).toHaveCount(0);
  await desktop.page
    .locator(".d-sidebar-bottom")
    .getByRole("button", { name: "设置", exact: false })
    .click();
  await desktop.page
    .getByRole("navigation", { name: "设置分类" })
    .getByRole("button", { name: "使用教学", exact: true })
    .click();
  await desktop.page.getByRole("button", { name: "重新开始引导教学", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).guide.completed.length).toBe(0);
  expect((await state(desktop)).insights.encounters).toBe(0);
});

test("真实词典升级取消、811092 词 Full 挂载与回退；个人笔记保留", async ({ desktopFactory }) => {
  // Full 索引接近 900 MiB，包含取消后重建和完整性校验。
  // 本机资源繁忙时构建可能超过五分钟；保留十分钟上限，仍校验全部真实词条。
  test.setTimeout(600000);
  const desktop = await desktopFactory.start({
    extraEnv: {
      LEXIMEET_DICTIONARY_SOURCE: dictionarySource(),
    },
  });
  await ready(desktop);
  await command(desktop, {
    action: "collect",
    word: "serendipity",
    note: "切换词典仍保留的笔记",
  });
  await desktop.page.evaluate(() => {
    window.__install = window.leximeet
      .dictionaryAction({ action: "install", edition: "full-text" })
      .catch((error) => ({ error: error.message }));
  });
  await expect
    .poll(() =>
      desktop.page
        .evaluate(() => window.leximeet.dictionaryAction({ action: "status" }))
        .then((value) => value.busy),
    )
    .toBe(true);
  await desktop.page.evaluate(() => window.leximeet.dictionaryAction({ action: "cancel" }));
  await desktop.page.evaluate(() => window.__install);
  expect((await state(desktop)).dictionary.entryCount).toBe(117902);
  const installed = await desktop.page.evaluate(() =>
    window.leximeet.dictionaryAction({
      action: "install",
      edition: "full-text",
    }),
  );
  expect(installed.active.entryCount).toBe(811092);
  // 整库状态过滤不能退化成只筛当前页，也不能把公共词批量写入个人资料。
  const pendingWords = await query(desktop, {
    scope: "dictionary",
    learningStatus: "new",
    offset: 10000,
    limit: 40,
  });
  expect(pendingWords.total).toBe(811092);
  expect(pendingWords.words).toHaveLength(40);
  expect((await query(desktop, { scope: "dictionary", learningStatus: "mastered" })).total).toBe(0);
  expect(
    (await query(desktop, { scope: "dictionary", search: "serendipity" })).words.some(
      (item) => item.note === "切换词典仍保留的笔记",
    ),
  ).toBe(true);
  await desktop.page.evaluate(() => window.leximeet.dictionaryAction({ action: "rollback" }));
  expect((await state(desktop)).dictionary.entryCount).toBe(117902);
  expect((await query(desktop, { scope: "manual", search: "serendipity" })).words[0].note).toBe(
    "切换词典仍保留的笔记",
  );
  await desktop.close();
});

test("明亮/黑暗/窄窗真实界面与 IPC 权限，刷新不覆盖笔记草稿", async ({
  desktopFactory,
}, testInfo) => {
  const desktop = await desktopFactory.start();
  await ready(desktop);
  const page = desktop.page;
  const output = path.join(root, "test-results/desktop-001/after");
  fs.mkdirSync(output, { recursive: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => window.leximeet.settings({ theme: value }), theme);
    await page.reload();
    await expect(page.locator(".desktop-shell")).toBeVisible();
    await page.waitForFunction((value) => document.documentElement.dataset.theme === value, theme);
    await page.screenshot({
      path: path.join(output, `${theme}.png`),
      scale: "css",
    });
  }
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(page.locator(".guide-overlay")).toHaveCount(0);
  // 收藏当前由词典词卡完成；沿正式界面加入词库，不用已移除的词库操作菜单。
  await page.getByRole("button", { name: "搜索整个词典", exact: true }).click();
  await page.getByRole("textbox", { name: "搜索单词", exact: true }).fill("serendipity");
  await expect(page.locator(".word-table tbody tr")).toHaveCount(1);
  await page.locator(".word-table tbody tr").click();
  await page.getByRole("button", { name: "加入手动收藏", exact: true }).click();
  await expect.poll(async () => (await state(desktop)).insights.manualWords).toBe(1);
  await nav(desktop, "我的词库");
  await expect(page.locator(".word-table tbody tr")).toHaveCount(1);
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  await page.getByRole("textbox", { name: "我的笔记" }).fill("刷新后仍保留的未提交草稿");
  await page.getByRole("button", { name: "切换明亮主题" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "切换黑暗主题" }).click();
  await expect(page.getByRole("textbox", { name: "我的笔记" })).toHaveValue(
    "刷新后仍保留的未提交草稿",
  );
  await resizeDesktop(desktop, 820, 760);
  // 验收上下停靠的几何关系，而不是绑定 CSS 必须使用 grid。
  await expect
    .poll(() =>
      page.evaluate(() => {
        const list = document.querySelector(".d-word-list").getBoundingClientRect();
        const detail = document.querySelector(".d-detail-column").getBoundingClientRect();
        const main = document.querySelector(".d-main");
        return (
          detail.top >= list.bottom - 1 &&
          detail.left >= list.left - 1 &&
          detail.right <= innerWidth &&
          main.scrollWidth <= main.clientWidth + 1
        );
      }),
    )
    .toBe(true);
  await page.screenshot({
    path: path.join(output, "narrow-library.png"),
    scale: "css",
  });
  const permissions = await page.evaluate(() => ({
    node: typeof window.require,
    process: typeof window.process,
    raw: typeof window.leximeet.request,
    mount: typeof window.leximeet.mount,
  }));
  expect(permissions).toEqual({
    node: "undefined",
    process: "undefined",
    raw: "undefined",
    mount: "undefined",
  });
  await expect(
    page.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "arbitrarySql",
        sql: "DROP TABLE words",
      }),
    ),
  ).rejects.toThrow("桌面命令不存在");
  expect((await query(desktop, { kind: "encounters" })).total).toBe(0);
  await testInfo.attach("窄窗口", {
    path: path.join(output, "narrow-library.png"),
    contentType: "image/png",
  });
  await desktop.close();
});

test("删除关系的实际界面：保留旧草稿、阻止覆盖、加载当前版本后重新保存", async ({
  desktopFactory,
}) => {
  const desktop = await desktopFactory.start();
  await ready(desktop);
  await desktop.page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await expect(desktop.page.locator(".guide-overlay")).toHaveCount(0);
  // 通过正式用例准备关联资料；随后所有删除、冲突处理和保存都由真实 UI 完成。
  await command(desktop, { action: "createBook", name: "并发主词本" });
  await command(desktop, { action: "createBook", name: "并发次词本" });
  const seeded = await state(desktop);
  const books = ["并发主词本", "并发次词本"].map(
    (name) => seeded.books.find((book) => book.name === name).id,
  );
  await command(desktop, {
    action: "collect",
    word: "serendipity",
    note: "原笔记",
    bookIds: books,
  });
  const page = desktop.page;
  await page.reload();
  await ready(desktop);
  await nav(desktop, "我的词库");
  await page.getByRole("button", { name: "编辑笔记与归类", exact: true }).click();
  const note = page.getByRole("textbox", { name: "我的笔记" });
  await expect(note).toHaveValue("原笔记");
  await note.fill("尚未提交的理解");
  await page.getByRole("button", { name: "删除 并发次词本", exact: true }).click();
  await page.getByRole("button", { name: "确认移除", exact: true }).click();
  await expect(
    page.getByText("资料已更新，草稿保留。请先复制草稿，再载入当前版本。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(note).toHaveValue("尚未提交的理解");
  await expect(page.getByRole("button", { name: "保存笔记与归类", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "载入当前版本", exact: true }).click();
  await note.fill("另一窗口更新之前的草稿");
  // 模拟另一窗口通过正式笔记命令保存；当前编辑器必须保留草稿并提示版本冲突。
  const current = await query(desktop, { kind: "detail", wordId: "serendipity" });
  await command(desktop, {
    action: "saveNote",
    wordId: "serendipity",
    note: "另一窗口的已保存理解",
    bookIds: [books[0]],
    expectedRevision: current.revision,
  });
  await nav(desktop, "今日学习");
  await nav(desktop, "我的词库");
  await expect(note).toHaveValue("另一窗口更新之前的草稿");
  await expect(page.getByRole("button", { name: "载入当前版本", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "载入当前版本", exact: true }).click();
  await note.fill("当前版本的安全保存");
  await page.getByRole("button", { name: "保存笔记与归类", exact: true }).click();
  const detail = await query(desktop, {
    kind: "detail",
    wordId: "serendipity",
  });
  expect(detail.note).toBe("当前版本的安全保存");
  expect(detail.books).toHaveLength(1);
  expect((await state(desktop)).insights.encounters).toBe(0);
  await desktop.close();
});
