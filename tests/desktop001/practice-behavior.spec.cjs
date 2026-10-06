"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");
const http = require("node:http");
const state = (desktop) => desktop.page.evaluate(() => window.leximeet.desktopState());
// 使用可解码的无声 WAV，仍经过 Main Provider 与真实播放器，不发出系统声音。
function audio() {
  const b = Buffer.alloc(44 + 3200);
  b.write("RIFF");
  b.writeUInt32LE(b.length - 8, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(3200, 40);
  return b;
}
test("六种练习真实反馈：列表无正误、临摹弱证据、独立输入校验、提示不冒充掌握，语境隐藏完整单词", async ({
  desktopFactory,
}) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "audio/wav" });
    res.end(audio());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const desktop = await desktopFactory.start();
    const page = desktop.page;
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.evaluate(async (url) => {
      await window.leximeet.audioSettings({
        action: "save",
        provider: "custom",
        custom: { url, method: "GET", body: "" },
      });
      await window.leximeet.desktopCommand({
        action: "capture",
        word: "serendipity",
        context: "It was serendipity, a welcome discovery.",
      });
    }, `http://127.0.0.1:${server.address().port}/audio?word={word}`);
    await page.reload();
    await expect(page.getByRole("button", { name: "开始今日学习", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "开始今日学习", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveText([
      "单词列表",
      "看词选义",
      "单词临摹",
      "单词默写",
      "听音辨词",
      "语境填空",
    ]);
    // 真实加载遮挡切换图标，避免遗漏资源时只验证文字仍然通过。
    await expect
      .poll(() =>
        page
          .locator('[data-guide="practice-mask"] img')
          .evaluate((icon) => icon.complete && icon.naturalWidth > 0),
      )
      .toBe(true);
    await page.getByRole("button", { name: "不熟悉 −1", exact: true }).click();
    await page.getByRole("button", { name: "新一轮回想", exact: true }).click();
    await page.getByRole("button", { name: "熟练 +1", exact: true }).click();
    await expect(page.locator(".signal-count")).toHaveText("1 熟 · 1 不熟悉");
    await expect(page.locator(".practice-feedback")).toHaveCount(0);
    expect((await state(desktop)).insights.practiceAnswers).toBe(0);
    await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
    await page.getByRole("button", { name: "练习设置", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "自动进入下一词" })).toBeChecked();
    await page.getByRole("checkbox", { name: "自动进入下一词" }).uncheck();
    await page.getByRole("textbox", { name: "练习答案" }).fill("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).press("Enter");
    await expect(page.locator(".practice-feedback")).toContainText("已记录");
    expect((await state(desktop)).insights.practiceAnswers).toBe(0);
    await page.getByRole("tab", { name: "单词默写", exact: true }).click();
    await expect(page.locator(".practice-question")).not.toContainText("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).fill("wrong");
    expect(await page.locator(".spelling-letters .wrong, .spelling-letters .typed").count()).toBe(
      0,
    );
    await page.getByRole("textbox", { name: "练习答案" }).press("Enter");
    await expect(page.locator(".practice-feedback")).toContainText("再回想");
    expect((await state(desktop)).insights).toMatchObject({
      practiceAnswers: 1,
      practiceCorrect: 0,
    });
    await page.getByRole("button", { name: "提示", exact: true }).click();
    // 提示只揭示幽灵文字，订正仍由用户输入；不能把完整答案写进真实输入。
    await expect(page.getByRole("textbox", { name: "练习答案" })).toHaveValue("wrong");
    await expect(page.getByRole("textbox", { name: "练习答案" })).toBeEditable();
    await expect(page.locator(".spelling-letters .ghost")).toHaveCount("serendipity".length - 5);
    await page.getByRole("textbox", { name: "练习答案" }).fill("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).press("Enter");
    await expect(page.getByText("已用提示 · 本题不加分", { exact: true })).toBeVisible();
    expect((await state(desktop)).insights.practiceAnswers).toBe(1);
    await page.getByRole("tab", { name: "听音辨词", exact: true }).click();
    await page.getByRole("textbox", { name: "练习答案" }).fill("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).press("Enter");
    await expect.poll(async () => (await state(desktop)).insights.practiceCorrect).toBe(1);
    await page.getByRole("tab", { name: "语境填空", exact: true }).click();
    await expect(page.locator(".practice-question")).toContainText("_____");
    await expect(page.locator(".practice-question")).not.toContainText("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).fill("serendipity");
    await page.getByRole("textbox", { name: "练习答案" }).press("Enter");
    await expect.poll(async () => (await state(desktop)).insights.practiceCorrect).toBe(2);
    const detail = await page.evaluate(() =>
      window.leximeet.desktopQuery({ kind: "detail", wordId: "serendipity" }),
    );
    expect(detail.status).toBe("learning");
    expect(detail.familiarity).toMatchObject({
      familiar: 1,
      unfamiliar: 1, // 同题先答错再揭示，首次反馈之外不增加另一条不熟悉信号。
      independent: 2,
    });
    expect((await state(desktop)).insights.encounters).toBe(1);
    await page.getByRole("button", { name: "熟记", exact: true }).click();
    await expect(page.getByRole("heading", { name: "已完成本轮练习", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "再练一轮", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "练习答案" })).toHaveValue("");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
