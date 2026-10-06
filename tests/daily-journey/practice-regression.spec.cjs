"use strict";
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { dropFirstWordListAck } = require("../helpers/practice-ack-loss.cjs");
const { dropFirstConfirmedHintRead } = require("../helpers/hint-read-loss.cjs");
const {
  failFirstConfirmedDraftSave,
  holdFirstPracticeDraftSave,
} = require("../helpers/practice-save-loss.cjs");
const { personalFacts, attachJson } = require("../helpers/journey-evidence.cjs");

function executable() {
  return process.env.LEXIMEET_JOURNEY_EXECUTABLE
    ? requireExecutable(process.env.LEXIMEET_JOURNEY_EXECUTABLE, "LEXIMEET_JOURNEY_EXECUTABLE")
    : undefined;
}
const detail = (page, wordId) =>
  page.evaluate((id) => window.leximeet.desktopQuery({ kind: "detail", wordId: id }), wordId);

// 真实用户入口和真实提交；故障段只丢弃真实读取回执，不伪造保存成功或分数。
test("已记分反馈须解锁重开，自动换词清空旧正确状态且保留新题释义", async ({
  desktopFactory,
}, testInfo) => {
  const desktop = await desktopFactory.start({
    executablePath: executable(),
    poisonHostJava: !!process.env.LEXIMEET_JOURNEY_EXECUTABLE,
  });
  const page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["apple", "banana"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `I remember this ${word} today.`,
      });
  });
  await page.locator('[data-guide="nav-practice"]').click();
  const restart = page.getByRole("button", { name: "重新开始", exact: true });
  const rows = page.locator(".practice-list-table tbody tr");
  await expect(rows).toHaveCount(2);
  await rows
    .filter({ hasText: "apple" })
    .getByRole("button", { name: "熟练 +1", exact: true })
    .click();
  await expect.poll(async () => (await detail(page, "apple")).familiarity.score).toBe(11);
  await expect(restart, "Core 已确认 +1，不能仍被假未决反馈锁住").toBeEnabled();
  await restart.click();
  await expect(
    rows.filter({ hasText: "apple" }).getByRole("button", { name: "熟练 +1", exact: true }),
  ).toBeEnabled();
  await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
  const input = page.getByRole("textbox", { name: "练习答案", exact: true });
  const first = (await page.locator(".spelling-letters").innerText()).trim();
  await expect(input).toBeEnabled();
  await input.pressSequentially(first, { delay: 15 });
  await expect
    .poll(async () => (await detail(page, first)).familiarity.score)
    .toBe(first === "apple" ? 12 : 11);
  await expect(page.locator(".spelling-letters")).not.toHaveText(first);
  await expect(input).toHaveValue("");
  await expect(page.locator(".practice-stage")).not.toHaveClass(/\bcorrect\b/);
  await expect(page.locator(".practice-instruction"), "换词后的中文释义不能消失").toHaveText(/\S/);
  await expect(restart).toBeEnabled();
  const second = (await page.locator(".spelling-letters").innerText()).trim();
  await input.pressSequentially(second, { delay: 15 });
  await expect(page.getByRole("heading", { name: "已完成本轮练习", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "再练一轮", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  const repeated = (await page.locator(".spelling-letters").innerText()).trim();
  const scoreBeforeRapid = (await detail(page, repeated)).familiarity.score;
  // 模拟完整输入后连按确认：100ms 自动确认和手动 Enter 共用同一提交，不能重复计分。
  await input.fill(repeated);
  await input.press("Enter");
  await input.press("Enter");
  await expect
    .poll(async () => (await detail(page, repeated)).familiarity.score)
    .toBe(scoreBeforeRapid + 1);
  await expect(restart).toBeEnabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.getByRole("tab", { name: "单词默写", exact: true }).click();
  await expect(input).toBeEnabled();
  const beforeHint = personalFacts(desktop.profileDir);
  const scoresBeforeHint = Object.fromEntries(
    await Promise.all(
      ["apple", "banana"].map(async (word) => {
        const value = await detail(page, word);
        return [value.id, value.familiarity.score];
      }),
    ),
  );
  const hintFault = await dropFirstConfirmedHintRead(desktop);
  try {
    await page.getByRole("button", { name: "提示", exact: true }).click();
    await expect(page.locator(".practice-recovery")).toContainText("测试提示读取失败");
    const recoverHint = page.getByRole("button", { name: "重新读取提示", exact: true });
    await expect(recoverHint).toBeEnabled();
    const hintAfter = testInfo.outputPath("evidence", "practice-hint-read-after.png");
    fs.mkdirSync(path.dirname(hintAfter), { recursive: true });
    await page.screenshot({ path: hintAfter, animations: "disabled", scale: "css" });
    await testInfo.attach("practice-hint-read-after", {
      path: hintAfter,
      contentType: "image/png",
    });
    const failedRead = await hintFault.snapshot();
    expect(failedRead.dropped).toBe(true);
    expect(failedRead.records).toHaveLength(1);
    expect(failedRead.reads).toHaveLength(1);
    const recordedHint = failedRead.records[0];
    expect(recordedHint.request).toMatchObject({ mode: "recall", signal: "reveal" });
    expect(recordedHint.confirmed).toMatchObject({
      submissionId: recordedHint.request.submissionId,
      delta: -1,
      effective: true,
      duplicate: false,
      assisted: true,
    });
    const afterHint = personalFacts(desktop.profileDir);
    expect(afterHint.practice).toHaveLength(beforeHint.practice.length + 1);
    expect(afterHint.practice.slice(0, -1)).toEqual(beforeHint.practice);
    expect(afterHint.practice.at(-1)).toMatchObject({
      word_id: recordedHint.request.wordId,
      signal: "reveal",
      mode: "recall",
      submission_id: recordedHint.request.submissionId,
      attempt_id: recordedHint.confirmed.attemptId,
    });
    expect((await detail(page, recordedHint.request.wordId)).familiarity.score).toBe(
      scoresBeforeHint[recordedHint.request.wordId] - 1,
    );
    await recoverHint.click();
    await expect(page.locator(".practice-recovery")).toHaveCount(0);
    const recoveredRead = await hintFault.snapshot();
    expect(recoveredRead.records, "提示读取重试不能再次发送扣分命令").toHaveLength(1);
    expect(recoveredRead.reads).toHaveLength(2);
    expect(recoveredRead.reads[1]).toEqual(recoveredRead.reads[0]);
    await expect(input).toHaveValue("");
    await expect(page.locator(".spelling-letters .ghost")).toHaveCount(
      recoveredRead.reads[1].confirmed.word.length,
    );
    expect(personalFacts(desktop.profileDir).practice).toEqual(afterHint.practice);
    expect((await detail(page, recordedHint.request.wordId)).familiarity.score).toBe(
      scoresBeforeHint[recordedHint.request.wordId] - 1,
    );
    await expect(restart, "提示扣分已确认且读取恢复，不能永久锁住重开").toBeEnabled();
    await attachJson(testInfo, "actual-hint-read-recovery", {
      failedRead,
      recoveredRead,
      beforeHint,
      afterHint,
    });
  } finally {
    await hintFault.restore();
  }
  await restart.click();
  await expect(input).toBeEditable();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("alert")).toHaveCount(0);
  // 重新进入会恢复题型；与切换题型不同，此时只有 loading、没有 transitioning。
  for (const [mode, label] of [
    ["listening", "听音辨词"],
    ["meaning-choice", "看词选义"],
  ]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await expect(restart).toBeEnabled();
    if (mode === "listening") {
      await input.fill("unfinished");
      await expect
        .poll(async () => {
          const position = await page.evaluate(async () => {
            const request = { scope: "library", mode: "listening" };
            const current = await window.leximeet.desktopQuery({ kind: "practice", ...request });
            const rows = await window.leximeet.desktopQuery({
              kind: "practiceWords",
              ...request,
              offset: current.cursor,
              limit: 1,
            });
            return window.leximeet.desktopQuery({
              kind: "practice",
              ...request,
              wordId: rows.words[0].id,
            });
          });
          return position.draft.input;
        })
        .toBe("unfinished");
    }
    await page.locator('[data-guide="nav-library"]').click();
    const draft = await holdFirstPracticeDraftSave(desktop, mode);
    try {
      await page.locator('[data-guide="nav-practice"]').click();
      await expect.poll(async () => (await draft.snapshot()).held).toBe(true);
      await expect(page.getByRole("tab", { name: label, exact: true })).toHaveAttribute(
        "aria-selected",
        "true",
      );
      const hint = page.getByRole("button", { name: "提示", exact: true });
      await expect(hint).toBeDisabled();
      if (mode === "listening") {
        await expect(input).toHaveValue("unfinished");
        await expect(input).toBeDisabled();
        await expect(page.getByRole("button", { name: "确认答案", exact: true })).toBeDisabled();
      } else {
        await expect(page.locator(".meaning-choice")).toHaveCount(4);
        for (const choice of await page.locator(".meaning-choice").all())
          await expect(choice).toBeDisabled();
      }
      await draft.release();
      await expect(hint).toBeEnabled();
      if (mode === "listening") {
        await expect(input).toBeEditable();
        await expect(page.getByRole("button", { name: "确认答案", exact: true })).toBeEnabled();
        await input.fill("");
      } else
        for (const choice of await page.locator(".meaning-choice").all())
          await expect(choice).toBeEnabled();
      expect((await draft.snapshot()).succeeded).toBe(true);
    } finally {
      await draft.restore();
    }
  }
  await testInfo.attach("practice-real-state", {
    body: Buffer.from(
      JSON.stringify(await page.evaluate(() => window.leximeet.desktopState()), null, 2),
    ),
    contentType: "application/json",
  });
});

test("教学临摹成功导航后再进入练习，已确认草稿不能残留未决锁", async ({
  desktopFactory,
}, testInfo) => {
  // 只替换音频来源为本例无声 WAV，仍经过真实 Main 提供者/播放器自然结束。
  const wav = Buffer.alloc(44 + 3200);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(3200, 40);
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "audio/wav" });
    response.end(wav);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const desktop = await desktopFactory.start({
      executablePath: executable(),
      poisonHostJava: !!process.env.LEXIMEET_JOURNEY_EXECUTABLE,
    });
    const page = desktop.page;
    await page.evaluate(
      (url) =>
        window.leximeet.audioSettings({
          action: "save",
          provider: "custom",
          custom: { url, method: "GET", body: "" },
        }),
      `http://127.0.0.1:${server.address().port}/word?word={word}`,
    );
    await page.getByRole("button", { name: "进入教学", exact: true }).click();
    await page.locator(".guide-step-action button:last-child").click();
    await page.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
    const listDraft = await holdFirstPracticeDraftSave(desktop, "word-list");
    try {
      await page.getByRole("button", { name: "保存学习规划", exact: true }).click();
      await expect(page.locator(".guide-coach")).toContainText("回想一个单词");
      await expect(page.getByRole("dialog", { name: "设置学习规划", exact: true })).toHaveCount(0);
      await expect.poll(async () => (await listDraft.snapshot()).held).toBe(true);
      const firstRow = page.locator('[data-guide="practice-row"]');
      await expect(firstRow).toBeVisible();
      const waitingPath = testInfo.outputPath("evidence", "practice-list-loading.png");
      fs.mkdirSync(path.dirname(waitingPath), { recursive: true });
      await page.screenshot({ path: waitingPath, animations: "disabled", scale: "css" });
      await testInfo.attach("practice-list-loading", {
        path: waitingPath,
        contentType: "image/png",
      });
      // 行已可见不能冒充可操作；首次草稿落盘前的点击会被 session.loading 拒绝。
      await expect(firstRow.getByRole("button", { name: "熟练 +1", exact: true })).toBeDisabled();
      await expect(firstRow.getByRole("button", { name: "不熟悉 −1", exact: true })).toBeDisabled();
      await expect(firstRow.getByRole("button", { name: "揭示中文", exact: true })).toBeDisabled();
      await listDraft.release();
      await firstRow.getByRole("button", { name: "熟练 +1", exact: true }).click();
      expect((await listDraft.snapshot()).succeeded).toBe(true);
    } finally {
      await listDraft.restore();
    }
    await expect(page.locator(".guide-coach")).toContainText("听单词发音");
    const copyDraft = await holdFirstPracticeDraftSave(desktop, "copy");
    try {
      await page.getByRole("button", { name: "美式", exact: true }).click();
      await expect(page.locator(".guide-coach")).toContainText("试一次单词临摹");
      await expect.poll(async () => (await copyDraft.snapshot()).held).toBe(true);
      const input = page.getByRole("textbox", { name: "练习答案", exact: true });
      await expect(input).toBeVisible();
      const waitingPath = testInfo.outputPath("evidence", "practice-copy-loading.png");
      await page.screenshot({ path: waitingPath, animations: "disabled", scale: "css" });
      await testInfo.attach("practice-copy-loading", {
        path: waitingPath,
        contentType: "image/png",
      });
      await expect(input, "首次临摹草稿保存期间不能接受又静默丢弃键入").toBeDisabled();
      await copyDraft.release();
      await expect(input).toBeEditable();
    } finally {
      await copyDraft.restore();
    }
    const word = (await page.locator(".spelling-letters").innerText()).trim();
    const before = await detail(page, word);
    const beforeFacts = personalFacts(desktop.profileDir);
    const draftFault = await failFirstConfirmedDraftSave(desktop, before.id);
    try {
      await page
        .getByRole("textbox", { name: "练习答案", exact: true })
        .pressSequentially(word, { delay: 15 });
      await expect(page.locator(".practice-recovery")).toContainText("测试确认草稿保存失败");
      await expect(
        page.locator(".guide-coach"),
        "确认草稿未落盘时教学须留在本题，不能提前切页隐藏恢复入口",
      ).toContainText("试一次单词临摹");
      const retrySave = page.getByRole("button", { name: "重试保存", exact: true });
      await expect(retrySave).toBeEnabled();
      const failedSave = await draftFault.snapshot();
      // 按真实 Main 资料变更事件触发 300ms Renderer refresh，不能用直接调用 controller 绕开竞态。
      await desktop.app.evaluate(({ BrowserWindow }, pageUrl) => {
        const main = BrowserWindow.getAllWindows().find(
          (window) => !window.isDestroyed() && window.webContents.getURL() === pageUrl,
        );
        if (!main) throw new Error("未找到本例练习页面所属窗口，不能冒充真实资料刷新");
        main.webContents.send("leximeet:data-changed");
      }, page.url());
      await expect
        .poll(
          async () => (await draftFault.snapshot()).stateReads.length,
          "资料事件须实际走过 Renderer→Main→Core 状态读取",
        )
        .toBeGreaterThan(failedSave.stateReads.length);
      const refreshedFailure = await draftFault.snapshot();
      expect(refreshedFailure.stateReads.at(-1).succeeded).toBe(true);
      await expect(
        page.locator(".guide-coach"),
        "重新读取已计分 Core 状态也不能绕过原确认草稿恢复",
      ).toContainText("试一次单词临摹");
      await expect(page.locator(".practice-recovery")).toContainText("测试确认草稿保存失败");
      await expect(retrySave).toBeEnabled();
      const afterPath = testInfo.outputPath("evidence", "practice-confirmed-save-after.png");
      fs.mkdirSync(path.dirname(afterPath), { recursive: true });
      await page.screenshot({ path: afterPath, animations: "disabled", scale: "css" });
      await testInfo.attach("practice-confirmed-save-after", {
        path: afterPath,
        contentType: "image/png",
      });
      expect(failedSave.failed).toBe(true);
      expect(failedSave.records).toHaveLength(1);
      const first = failedSave.records[0];
      expect(first.request).toMatchObject({
        action: "practiceRecord",
        wordId: before.id,
        mode: "copy",
        answer: word,
      });
      expect(first.confirmed).toMatchObject({
        submissionId: first.request.submissionId,
        correct: true,
        effective: true,
        duplicate: false,
        delta: 1,
      });
      expect(failedSave.saves[0]).toMatchObject({
        forwarded: false,
        succeeded: false,
        request: {
          wordId: before.id,
          mode: "copy",
          draft: { attemptId: first.request.attemptId, answered: true, pendingSubmission: null },
        },
      });
      const committedFacts = personalFacts(desktop.profileDir);
      expect(committedFacts.practice).toHaveLength(beforeFacts.practice.length + 1);
      expect(committedFacts.practice.slice(0, -1)).toEqual(beforeFacts.practice);
      expect(committedFacts.practice.at(-1)).toMatchObject({
        submission_id: first.request.submissionId,
        attempt_id: first.confirmed.attemptId,
        word_id: before.id,
        mode: "copy",
        correct: 1,
      });
      expect((await detail(page, word)).familiarity.score).toBe(before.familiarity.score + 1);
      // 真实点击同时验证教学遮罩的 allow/recovery gate；不强制点击或旁路调用。
      await retrySave.click();
      await expect(page.locator(".guide-coach")).toContainText("复制句子，遇见单词");
      await expect(page.getByRole("alert").filter({ hasText: "测试确认草稿保存失败" })).toHaveCount(
        0,
      );
      const restoredSave = await draftFault.snapshot();
      expect(restoredSave.records).toHaveLength(2);
      expect(restoredSave.records[1].request).toEqual(first.request);
      expect(restoredSave.records[1].confirmed).toMatchObject({
        submissionId: first.request.submissionId,
        attemptId: first.confirmed.attemptId,
        correct: true,
        duplicate: true,
      });
      expect(
        restoredSave.saves.some(
          (save) =>
            save.forwarded &&
            save.succeeded &&
            save.request.draft.attemptId === first.request.attemptId &&
            save.request.draft.answered === true &&
            save.request.draft.pendingSubmission === null,
        ),
        "原题确认草稿须确实写入 Core 成功后教学才能推进",
      ).toBe(true);
      expect(personalFacts(desktop.profileDir).practice).toEqual(committedFacts.practice);
      expect((await detail(page, word)).familiarity.score).toBe(before.familiarity.score + 1);
      await attachJson(testInfo, "actual-guide-confirmed-draft-save-recovery", {
        failedSave,
        refreshedFailure,
        restoredSave,
        beforeFacts,
        committedFacts,
      });
    } finally {
      await draftFault.restore();
    }
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.locator('[data-guide="nav-practice"]').click();
    await expect(page.getByRole("tab", { name: "单词临摹", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const draft = await page.evaluate(
      (id) =>
        window.leximeet.desktopQuery({
          kind: "practice",
          scope: "library",
          mode: "copy",
          wordId: id,
        }),
      before.id,
    );
    await testInfo.attach("guide-confirmed-draft", {
      body: Buffer.from(
        JSON.stringify({ score: (await detail(page, word)).familiarity.score, draft }, null, 2),
      ),
      contentType: "application/json",
    });
    await expect(
      page.getByRole("button", { name: "重新开始", exact: true }),
      "教学自动导航不能把已确认答题永久保存为 pending",
    ).toBeEnabled();
    expect(draft.draft?.pendingSubmission ?? null).toBeNull();
    await page.getByRole("button", { name: "重新开始", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "练习答案", exact: true })).toBeEditable();
    await expect(page.getByRole("textbox", { name: "练习答案", exact: true })).toHaveValue("");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});

test("列表未知回执跨天重开后恢复原提交，不双计分且新一日可继续", async ({
  desktopFactory,
}, info) => {
  const profileDir = desktopFactory.newProfile();
  const clock = desktopFactory.businessClock(profileDir);
  const options = {
    profileDir,
    executablePath: executable(),
    poisonHostJava: !!process.env.LEXIMEET_JOURNEY_EXECUTABLE,
    extraEnv: clock.environment,
  };
  let desktop = await desktopFactory.start(options);
  let page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "apple",
      context: "An apple remains the same word across two learning days.",
    }),
  );
  const word = await detail(page, "apple");
  await page.locator('[data-guide="nav-practice"]').click();
  const row = page.locator(".practice-list-table tbody tr").filter({ hasText: "apple" });
  const fault = await dropFirstWordListAck(desktop);
  let dropped;
  try {
    await row.getByRole("button", { name: "熟练 +1", exact: true }).click();
    // 先确认真正丢弃了已提交 ACK；刷新后 UI 使用稳定的待确认提示，不能依赖故障注入的临时文案。
    await expect.poll(async () => (await fault.snapshot()).dropped).toBe(true);
    await expect(page.getByRole("alert").filter({ hasText: "尚未确认" })).toBeVisible();
    await expect(page.locator(".practice-recovery")).toContainText("重试保存");
    dropped = await fault.snapshot();
    expect(dropped.dropped).toBe(true);
    expect(dropped.first).toMatchObject({ wordId: word.id, mode: "word-list", signal: "familiar" });
    expect(dropped.confirmed).toMatchObject({
      submissionId: dropped.first.submissionId,
      correct: true,
      effective: true,
      duplicate: false,
    });
    expect(personalFacts(profileDir).practice).toHaveLength(1);
    expect((await detail(page, word.id)).familiarity.score).toBe(11);
    await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeDisabled();
  } finally {
    await fault.restore();
  }
  const committed = personalFacts(profileDir).practice[0];
  // UI seed 经 desktop_attempt_questions 映射到 Core 冻结题目的实际 attempt，两层身份分别保留。
  expect(committed).toMatchObject({
    submission_id: dropped.first.submissionId,
    attempt_id: dropped.confirmed.attemptId,
    study_day: "2026-10-05",
    signal: "familiar",
    correct: 1,
  });
  clock.advanceTo("2026-10-06T02:00:00Z");
  await desktop.close();
  desktop = await desktopFactory.start(options);
  page = desktop.page;
  expect((await page.evaluate(() => window.leximeet.desktopState())).today).toBe("2026-10-06");
  await page.locator('[data-guide="nav-practice"]').click();
  await expect(page.getByRole("button", { name: "重试保存", exact: true })).toBeVisible();
  const saved = await page.evaluate(
    (wordId) =>
      window.leximeet.desktopQuery({
        kind: "practice",
        scope: "library",
        mode: "word-list",
        wordId,
      }),
    word.id,
  );
  expect(saved.draft.listAttempts[word.id]).toMatchObject({
    id: dropped.first.attemptId,
    day: "2026-10-05",
    pending: { signal: "familiar", submissionId: dropped.first.submissionId },
  });
  await page.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeEnabled();
  await expect(page.locator(".practice-recovery")).toHaveCount(0);
  expect(personalFacts(profileDir).practice).toEqual([committed]);
  expect((await detail(page, word.id)).familiarity.score).toBe(11);
  const restored = await page.evaluate(
    (wordId) =>
      window.leximeet.desktopQuery({
        kind: "practice",
        scope: "library",
        mode: "word-list",
        wordId,
      }),
    word.id,
  );
  expect(restored.draft.listAttempts[word.id].pending).toBeUndefined();
  expect(restored.draft.listAttempts[word.id].finished).toBe("familiar");
  await page.getByRole("button", { name: "重新开始", exact: true }).click();
  await page
    .locator(".practice-list-table tbody tr")
    .filter({ hasText: "apple" })
    .getByRole("button", { name: "熟练 +1", exact: true })
    .click();
  await expect.poll(() => personalFacts(profileDir).practice.length).toBe(2);
  const continued = personalFacts(profileDir).practice;
  expect(continued[0]).toEqual(committed);
  expect(continued[1]).toMatchObject({ study_day: "2026-10-06", signal: "familiar", correct: 1 });
  expect(continued[1].submission_id).not.toBe(committed.submission_id);
  expect(continued[1].attempt_id).not.toBe(committed.attempt_id);
  expect((await detail(page, word.id)).familiarity.score).toBe(12);
  await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeEnabled();
  await attachJson(info, "actual-cross-day-unknown-ack", {
    dropped,
    committed,
    restored,
    continued,
    clock: clock.snapshot(),
    actualDay: (await page.evaluate(() => window.leximeet.desktopState())).today,
  });
});
