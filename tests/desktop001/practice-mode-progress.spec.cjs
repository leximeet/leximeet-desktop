"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { test, expect, resizeDesktop } = require("../helpers/electron-fixture.cjs");

// 用真实可解码的静音音频验收听力，不联网、不发声，不替换 Main 的播放生命周期。
function quietWav() {
  const bytes = Buffer.alloc(44 + 3200);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(3200, 40);
  return bytes;
}
const tabs = {
  copy: "单词临摹",
  recall: "单词默写",
  listening: "听音辨词",
  cloze: "语境填空",
  "meaning-choice": "看词选义",
  "word-list": "单词列表",
};
async function changeMode(page, mode) {
  await page.getByRole("tab", { name: tabs[mode], exact: true }).click();
  await expect(page.getByRole("tab", { name: tabs[mode], exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeEnabled();
}

test("模式游标与列表完成进度独立；听力提示为可编辑幽灵文字，重开与应用重启保留其他模式", async ({
  desktopFactory,
}, testInfo) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "audio/wav" });
    response.end(quietWav());
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const profileDir = desktopFactory.newProfile();
    let desktop = await desktopFactory.start({ profileDir });
    let page = desktop.page;
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.evaluate(async (url) => {
      await window.leximeet.audioSettings({
        action: "save",
        provider: "custom",
        custom: { url, method: "GET", body: "" },
      });
      for (const word of [
        "apple",
        "banana",
        "cherry",
        "dolphin",
        "elephant",
        "feather",
        "grape",
        "honey",
        "island",
        "jungle",
        "kitten",
        "lemon",
        "mango",
        "nectar",
        "olive",
        "pear",
      ])
        await window.leximeet.desktopCommand({
          action: "capture",
          word,
          context: `An example includes ${word}.`,
        });
    }, `http://127.0.0.1:${server.address().port}/word?word={word}`);
    await page.locator('[data-guide="nav-practice"]').click();
    await expect(page.locator(".practice-list-table tbody tr")).toHaveCount(12);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.locator(".list-pagination")).toContainText("2 / 2");
    const listRow = page.locator(".practice-list-table tbody tr").nth(1);
    const listWord = (await listRow.locator(".word-column").innerText()).trim();
    await listRow.getByRole("button", { name: "熟练 +1", exact: true }).click();
    await expect(listRow.getByRole("button", { name: "熟练 +1", exact: true })).toBeDisabled();

    await changeMode(page, "copy");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 / 16");
    await page.getByRole("button", { name: "练习设置", exact: true }).click();
    await page.getByRole("checkbox", { name: "自动进入下一词" }).uncheck();
    for (let i = 0; i < 2; i++) {
      await page.getByRole("button", { name: "下一词", exact: true }).click();
      await expect(page.locator(".practice-stage .eyebrow")).toContainText(`${i + 2} / 16`);
    }
    const input = page.getByRole("textbox", { name: "练习答案" });
    await input.fill("partial-copy");
    await changeMode(page, "listening");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 / 16");
    for (let i = 0; i < 4; i++) {
      await page.getByRole("button", { name: "下一词", exact: true }).click();
      await expect(page.locator(".practice-stage .eyebrow")).toContainText(`${i + 2} / 16`);
    }
    const listeningWord = await page.evaluate(async () => {
      const position = await window.leximeet.desktopQuery({
        kind: "practice",
        scope: "library",
        mode: "listening",
      });
      return (
        await window.leximeet.desktopQuery({
          kind: "practiceWords",
          scope: "library",
          mode: "listening",
          offset: position.cursor,
          limit: 1,
        })
      ).words[0];
    });
    await input.fill(listeningWord.word.slice(0, 2));
    await page.getByRole("button", { name: "提示", exact: true }).click();
    await expect(input).toHaveValue(listeningWord.word.slice(0, 2));
    await expect(input).toBeEditable();
    await expect(input).toBeFocused();
    expect(await input.evaluate((field) => [field.selectionStart, field.selectionEnd])).toEqual([
      2, 2,
    ]);
    await expect(page.locator(".spelling-letters .ghost")).toHaveCount(
      listeningWord.word.length - 2,
    );
    await expect(page.getByText("已用提示 · 本题不加分", { exact: true })).toBeVisible();
    // 提示之后仍使用真实方向键与中间插入，不以 fill 代替可编辑性验收。
    await input.press("ArrowLeft");
    await input.pressSequentially("x");
    await expect(input).toHaveValue(
      listeningWord.word.slice(0, 1) + "x" + listeningWord.word.slice(1, 2),
    );
    await input.press("Backspace");
    await expect(input).toHaveValue(listeningWord.word.slice(0, 2));
    await input.press("ArrowRight");

    // 明暗与窄窗截图记录真实改后控件；虚拟输入不会占用操作者键鼠。
    const directory =
      process.env.LEXIMEET_USABILITY_CAPTURE ||
      process.env.LEXIMEET_PRACTICE_PARITY_CAPTURE ||
      testInfo.outputPath("practice-parity");
    fs.mkdirSync(directory, { recursive: true });
    for (const theme of ["light", "dark"]) {
      if ((await page.locator("html").getAttribute("data-theme")) !== theme)
        await page
          .getByRole("button", {
            name: theme === "dark" ? "切换黑暗主题" : "切换明亮主题",
            exact: true,
          })
          .click();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      // 主题按钮会移走焦点；重新聚焦仍须恢复原草稿和真实光标，再记录幽灵文字。
      await input.focus();
      await expect(input).toHaveValue(listeningWord.word.slice(0, 2));
      expect(await input.evaluate((field) => [field.selectionStart, field.selectionEnd])).toEqual([
        2, 2,
      ]);
      await page.screenshot({
        path: path.join(directory, `listening-ghost-${theme}.png`),
        animations: "disabled",
      });
    }
    await resizeDesktop(desktop, 820, 600);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await page.screenshot({
      path: path.join(directory, "listening-ghost-dark-820.png"),
      animations: "disabled",
    });
    await resizeDesktop(desktop, 1321, 864);
    await input.focus();
    expect(await input.evaluate((field) => [field.selectionStart, field.selectionEnd])).toEqual([
      2, 2,
    ]);
    await input.press("Backspace");
    await expect(input).toHaveValue(listeningWord.word.slice(0, 1));
    await input.pressSequentially(listeningWord.word.slice(1));
    await input.press("Enter");
    await expect(page.locator(".practice-feedback")).toContainText("正确 · 已记录");
    expect(
      (
        await page.evaluate(
          (wordId) => window.leximeet.desktopQuery({ kind: "detail", wordId }),
          listeningWord.id,
        )
      ).familiarity.score,
    ).toBe(listeningWord.familiarity.score - 1);

    await changeMode(page, "copy");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("3 / 16");
    await expect(input).toHaveValue("partial-copy");
    await page.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "capture",
        word: "zebra",
        context: "A zebra appears in the new encounter.",
      }),
    );
    await page.getByRole("button", { name: "重新开始", exact: true }).click();
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 / 17");
    await expect(input).toHaveValue("");
    const refreshed = await page.evaluate(() =>
      window.leximeet.desktopQuery({
        kind: "practiceWords",
        scope: "library",
        mode: "copy",
        offset: 0,
        limit: 100,
      }),
    );
    expect(refreshed.words.map((word) => word.word)).toContain("zebra");
    await changeMode(page, "listening");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("5 / 16");
    await expect(input).toHaveValue(listeningWord.word);
    await expect(page.getByText("已用提示 · 本题不加分", { exact: true })).toBeVisible();
    await changeMode(page, "word-list");
    await expect(page.locator(".list-pagination")).toContainText("2 / 2");
    const completedRow = page
      .locator(".practice-list-table tbody tr")
      .filter({ hasText: listWord });
    await expect(completedRow.getByRole("button", { name: "熟练 +1", exact: true })).toBeDisabled();
    await desktop.close();
    desktop = await desktopFactory.start({ profileDir });
    page = desktop.page;
    await page.locator('[data-guide="nav-practice"]').click();
    await expect(page.locator(".list-pagination")).toContainText("2 / 2");
    await expect(
      page
        .locator(".practice-list-table tbody tr")
        .filter({ hasText: listWord })
        .getByRole("button", { name: "熟练 +1", exact: true }),
    ).toBeDisabled();
    await changeMode(page, "copy");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 / 17");
    await page.getByRole("button", { name: "练习设置", exact: true }).click();
    await page.getByRole("checkbox", { name: "自动进入下一词" }).uncheck();
    await changeMode(page, "listening");
    await expect(page.locator(".practice-stage .eyebrow")).toContainText("5 / 16");
    expect(desktop.pageErrors).toEqual([]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
