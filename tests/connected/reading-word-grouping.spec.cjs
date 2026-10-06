"use strict";
const { test, expect } = require("@playwright/test");
const { readingServer } = require("../../../plugin/leximeet-browser/tests/helpers/extension.cjs");
const {
  withLab,
  facts,
  independentFacts,
  pairThroughUi,
  desktopQuery,
} = require("./packaged-helpers.cjs");

// 用真正的独立模式管理入口准备 A；连接以后只读取，不向 IndexedDB 注入资料。
async function addStandaloneWord(lab, word) {
  const tutorial = lab.context.pages().find((page) => page.url().endsWith("/tutorial.html"));
  if (tutorial && (await tutorial.locator("#lesson-skip").isVisible()))
    await tutorial.locator("#lesson-skip").click();
  const manager = lab.workspace;
  const skip = manager.getByRole("button", { name: "跳过引导", exact: true });
  if (await skip.count()) await skip.click();
  await manager
    .getByRole("navigation", { name: "工作区导航" })
    .getByRole("button", { name: /^我的词库/ })
    .click();
  await manager.getByRole("button", { name: "添加单词", exact: true }).click();
  const dialog = manager.getByRole("dialog", { name: "查词与添加" });
  await dialog.getByRole("textbox", { name: "输入英文单词" }).fill(word);
  await expect(dialog.getByRole("heading", { name: word, exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "加入我的词库", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

test("随包真实连接：Node 重复与 The/the 归并，同句只保存一次，不同句保留且 A 不变", async ({}, info) => {
  await withLab(info, async (lab) => {
    for (const word of ["node", "the", "system"]) {
      await addStandaloneWord(lab, word);
      await lab.desktopPage.evaluate(
        (value) => globalThis.leximeet.desktopCommand({ action: "collect", word: value }),
        word,
      );
    }
    const original = independentFacts(await facts(lab.workspace));
    expect(original.words).toHaveLength(3);
    await pairThroughUi(lab, "plugin");
    // 固定真实 HTML 网页只为精确定位三个词项；分析、Native 通道和保存均由产品完成。
    const server = await readingServer(
      '<!doctype html><meta charset="utf-8"><title>Connected reading example</title>' +
        '<p><span data-word="node-0">Node</span> uses the system.</p>' +
        '<p><span data-word="node-1">Node</span> uses the system.</p>' +
        '<p>The system helps the reader and <span data-word="node-2">Node</span> learns.</p>',
    );
    try {
      await lab.reading.goto(server.url);
      const panel = await lab.openPanel();
      await panel.getByRole("button", { name: "分析本页", exact: true }).click();
      await expect(panel.locator(".lm-row")).toHaveCount(3);
      expect(
        (await panel.locator(".lm-row strong").allTextContents())
          .map((word) => word.toLowerCase())
          .sort(),
      ).toEqual(["node", "system", "the"]);
      // 随包驱动没有 Source 驱动的 worker 属性；从实际插件侧栏上下文读取 Chrome 注册表。
      const contexts = await panel.evaluate(() =>
        globalThis.chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
      );
      expect(contexts).toHaveLength(1);
      await panel.screenshot({ path: info.outputPath("packaged-word-grouping.png") });
      expect((await desktopQuery(lab, { kind: "encounters" })).total).toBe(0);
      for (const [position, expectedCount] of [
        [0, 1],
        [1, 1],
        [2, 2],
      ]) {
        await panel
          .getByRole("button", { name: position === 0 ? "采集" : "开始采集", exact: true })
          .click();
        await lab.reading.locator(`[data-word="node-${position}"]`).click();
        await expect(panel.locator(".lm-row")).toHaveCount(1);
        await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
        // 再次出现开始按钮才是本次保存完成；不能以立即读到旧计数冒充去重成功。
        await expect(panel.getByRole("button", { name: "开始采集", exact: true })).toBeVisible();
        await expect
          .poll(async () => (await desktopQuery(lab, { kind: "encounters" })).total)
          .toBe(expectedCount);
      }
      const encounters = (await desktopQuery(lab, { kind: "encounters" })).encounters;
      expect(new Set(encounters.map((item) => item.context))).toEqual(
        new Set(["Node uses the system.", "The system helps the reader and Node learns."]),
      );
      expect(new Set(encounters.map((item) => item.word.toLowerCase()))).toEqual(new Set(["node"]));
      expect(independentFacts(await facts(lab.workspace))).toEqual(original);
      lab.evidence.nativePanel = true;
      lab.evidence.readingWordGrouping = {
        rows: 3,
        sameSentenceEncounters: 1,
        differentSentences: 2,
        independentFactsUnchanged: true,
      };
    } finally {
      await server.close();
    }
  });
});
