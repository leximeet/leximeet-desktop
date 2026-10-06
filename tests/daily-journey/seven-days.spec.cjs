"use strict";
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");
const {
  personalFacts,
  workspaceRevision,
  applicationEvidence,
  attachJson,
} = require("../helpers/journey-evidence.cjs");
const { dropFirstClipboardSaveAck } = require("../helpers/clipboard-ack-loss.cjs");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const state = (page) => page.evaluate(() => window.leximeet.desktopState());
const detail = (page, wordId) =>
  page.evaluate((wordId) => window.leximeet.desktopQuery({ kind: "detail", wordId }), wordId);
const command = (page, input) =>
  page.evaluate((input) => window.leximeet.desktopCommand(input), input);
const feedback = (page, wordId, mode, answer, signal) =>
  command(page, {
    action: "practiceRecord",
    wordId,
    mode,
    ...(answer === undefined ? {} : { answer }),
    ...(signal ? { signal } : {}),
    submissionId: require("node:crypto").randomUUID(),
  });

async function openPlan(page, goal, initial = false) {
  await page.locator('[data-guide="nav-plan"]').click();
  await page
    .getByRole("button", { name: initial ? "设置学习规划" : "更换学习目标", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("searchbox", { name: "搜索学习目标" }).fill(goal);
  await dialog.locator(".planning-catalog").filter({ hasText: goal }).click();
  await dialog.getByRole("button", { name: "下一步：设置计划", exact: true }).click();
  await dialog.getByLabel("每天新学", { exact: true }).fill("2");
  await dialog.getByLabel("每天复习", { exact: true }).fill("2");
  await dialog.getByLabel("学习提醒", { exact: true }).check();
  await dialog.getByRole("button", { name: "保存学习规划", exact: true }).click();
  await expect(dialog).toHaveCount(0);
}

async function silentWav() {
  const wav = Buffer.alloc(3244);
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
  return {
    url: `http://127.0.0.1:${server.address().port}/word?word={word}`,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

test("七个业务日：学三天、休一天、再学三天，真实六模式、提醒、重开与资料保留", async ({
  desktopFactory,
}, info) => {
  const executablePath = process.env.LEXIMEET_JOURNEY_EXECUTABLE
    ? requireExecutable(process.env.LEXIMEET_JOURNEY_EXECUTABLE, "LEXIMEET_JOURNEY_EXECUTABLE")
    : undefined;
  const profileDir = desktopFactory.newProfile();
  const clock = desktopFactory.businessClock(profileDir);
  const audio = await silentWav();
  const daily = [];
  let desktop;
  try {
    desktop = await desktopFactory.start({
      profileDir,
      executablePath,
      poisonHostJava: !!executablePath,
      extraEnv: clock.environment,
    });
    let page = desktop.page;
    const fresh = await state(page);
    expect(fresh.today).toBe("2026-10-05");
    expect(fresh.zone).toBe("Asia/Shanghai");
    expect(fresh.profile).toMatchObject({ planEnabled: false, dailyNew: 10, dailyReview: 20 });
    expect(fresh.settings).toMatchObject({
      captureDuplicateWindowDays: 7,
      captureSensitiveRedactionEnabled: true,
      captureContextMaxLength: 500,
    });
    expect(personalFacts(profileDir).schemaVersion).toBe(100);
    await expect(page.getByRole("button", { name: "进入教学", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "跳过教学", exact: true }).click();
    await page.evaluate(
      (url) =>
        window.leximeet.audioSettings({
          action: "save",
          provider: "custom",
          custom: { url, method: "GET", body: "" },
        }),
      audio.url,
    );
    if (executablePath)
      await attachJson(info, "journey-actual-app", await applicationEvidence(desktop));

    async function checkpoint(day, note) {
      const current = await state(page),
        facts = personalFacts(profileDir);
      expect(current.today).toBe(day);
      daily.push({
        day,
        note,
        clock: clock.snapshot(),
        profile: current.profile,
        queue: current.queue,
        apple: (await detail(page, "apple")).familiarity,
        extra:
          day === "2026-10-05" ? null : (await detail(page, "journeyextraunknown")).familiarity,
        practiceCount: facts.practice.length,
        encounterCount: facts.encounters.length,
      });
    }
    await test.step("第1天：六种真实 UI 模式按 +1/+2 累计，20 分翌日才复习", async () => {
      await command(page, {
        action: "capture",
        word: "apple",
        context: "An apple keeps this learning journey connected.",
        sourceTitle: "手动记录",
      });
      expect((await detail(page, "apple")).familiarity).toMatchObject({ score: 10, status: "new" });
      await page.locator('[data-guide="nav-practice"]').click();
      await page
        .locator(".practice-list-table tbody tr")
        .getByRole("button", { name: "熟练 +1", exact: true })
        .click();
      await expect.poll(async () => (await detail(page, "apple")).familiarity.score).toBe(11);
      await page.getByRole("tab", { name: "看词选义", exact: true }).click();
      await page.getByRole("button", { name: "练习设置", exact: true }).click();
      await page.getByRole("checkbox", { name: "自动进入下一词", exact: true }).uncheck();
      await page.getByRole("button", { name: "练习设置", exact: true }).click();
      const frozen = await page.evaluate(async () => {
        const word = await window.leximeet.desktopQuery({ kind: "detail", wordId: "apple" });
        const current = await window.leximeet.desktopQuery({
          kind: "practice",
          scope: "library",
          mode: "meaning-choice",
          wordId: word.id,
        });
        return window.leximeet.desktopQuery({
          kind: "practiceQuestion",
          scope: "library",
          cursor: 0,
          wordId: word.id,
          mode: "meaning-choice",
          attemptId: current.draft.attemptId,
        });
      });
      expect(frozen.unavailable).not.toBe(true);
      await page.locator(".meaning-choice").filter({ hasText: frozen.meaning }).click();
      await expect.poll(async () => (await detail(page, "apple")).familiarity.score).toBe(12);
      for (const [name, score] of [
        ["单词临摹", 13],
        ["单词默写", 15],
        ["听音辨词", 16],
        ["语境填空", 18],
      ]) {
        await page.getByRole("tab", { name, exact: true }).click();
        const input = page.getByRole("textbox", { name: "练习答案", exact: true });
        await expect(input).toHaveValue("");
        await expect(page.locator(".practice-stage")).not.toHaveClass(/\bcorrect\b/);
        await input.pressSequentially("apple", { delay: 15 });
        if (["听音辨词", "语境填空"].includes(name))
          await page.getByRole("button", { name: "确认答案", exact: true }).click();
        await expect.poll(async () => (await detail(page, "apple")).familiarity.score).toBe(score);
        await expect(page.getByRole("button", { name: "重新开始", exact: true })).toBeEnabled();
      }
      const firstSix = personalFacts(profileDir).practice;
      expect(firstSix.map((item) => item.mode).sort()).toEqual([
        "cloze",
        "copy",
        "listening",
        "meaning-choice",
        "recall",
        "word-list",
      ]);
      expect(firstSix.every((item) => item.study_day === "2026-10-05" && item.correct === 1)).toBe(
        true,
      );
      await feedback(page, "apple", "recall", "apple");
      const graduated = (await detail(page, "apple")).familiarity;
      expect(graduated).toMatchObject({ score: 20, status: "review", graduatedDay: "2026-10-05" });
      expect(graduated.reviewEligibleAt).toBe("2026-10-05T16:00:00Z");
      await openPlan(page, "雅思词汇", true);
      expect((await state(page)).queue.reviews.some((item) => item.word === "apple")).toBe(false);
      await checkpoint("2026-10-05", "六模式累计 +8，再默写 +2，初学完成但当日不入复习");
    });

    await test.step("第2天：0 不熟悉、30 熟悉，两类状态筛选和笔记归类", async () => {
      clock.advanceTo("2026-10-06T02:00:00Z");
      for (let i = 0; i < 5; i++) await feedback(page, "apple", "recall", "apple");
      expect((await detail(page, "apple")).familiarity).toMatchObject({
        score: 30,
        status: "mastered",
      });
      await command(page, {
        action: "capture",
        word: "journeyextraunknown",
        note: "旅程中的自定义额外词",
        context: "A journeyextraunknown token belongs to my personal notebook.",
      });
      for (let i = 0; i < 12; i++)
        await feedback(page, "journeyextraunknown", "word-list", undefined, "unfamiliar");
      expect((await detail(page, "journeyextraunknown")).familiarity.score).toBe(0);
      await command(page, { action: "createBook", name: "七天记录" });
      const book = (await state(page)).books.find((item) => item.name === "七天记录");
      await command(page, {
        action: "collect",
        word: "apple",
        note: "第2天记录的联想",
        bookIds: [book.id],
      });
      await page.locator('[data-guide="nav-library"]').click();
      const tabs = page.getByRole("tablist", { name: "单词状态" });
      await tabs.getByRole("tab", { name: "不熟悉", exact: true }).click();
      await expect(page.locator(".library-table tbody tr")).toHaveCount(1);
      await expect(page.locator(".library-table tbody tr")).toContainText("journeyextraunknown");
      await tabs.getByRole("tab", { name: "已熟悉", exact: true }).click();
      await expect(page.locator(".library-table tbody tr")).toHaveCount(1);
      await expect(page.locator(".library-table tbody tr")).toContainText("apple");
      await checkpoint("2026-10-06", "错误扣到0后不再下降；apple 达30开始保护期，笔记和词本已保存");
    });

    await test.step("第3天：窗口内随机提醒经过 Main 调度和真实 Core 固定题目计分", async () => {
      clock.advanceTo("2026-10-07T02:00:00Z");
      const countBefore = personalFacts(profileDir).practice.length;
      await desktop.app.evaluate(() => globalThis.__leximeetTestStudy.tick());
      const scheduled = await desktop.app.evaluate(() => globalThis.__leximeetTestStudy.schedule());
      const deltaMinutes = (scheduled.nextAt - Date.parse(clock.snapshot().instant)) / 60000;
      expect(deltaMinutes).toBeGreaterThanOrEqual(25);
      expect(deltaMinutes).toBeLessThanOrEqual(35);
      clock.advanceTo(new Date(scheduled.nextAt).toISOString());
      expect(await desktop.app.evaluate(() => globalThis.__leximeetTestStudy.tick())).toBe(true);
      const pending = await page.evaluate(() =>
        window.leximeet.desktopQuery({ kind: "reminderQuestions" }),
      );
      expect(pending.questions).toHaveLength(1);
      const q = pending.questions[0];
      expect(q.mode).toBe("meaning-choice");
      const remindedBefore = (await detail(page, q.wordId)).familiarity.score;
      // 判题依据来自本次冻结通知题目，不假设词典第一条 sense 一定就是正确释义。
      const optionIndex = q.options.findIndex((item) => item.text === q.meaning);
      expect(optionIndex).toBeGreaterThanOrEqual(0);
      await desktop.app.evaluate(
        (_, value) => {
          const notice = globalThis.__leximeetTestStudy.notice(value.id);
          notice.emit("action", { actionIndex: value.optionIndex });
          notice.emit("action", { actionIndex: value.optionIndex });
        },
        { id: q.id, optionIndex },
      );
      await expect.poll(() => personalFacts(profileDir).practice.length).toBe(countBefore + 1);
      const answered = personalFacts(profileDir).practice.at(-1);
      expect(answered).toMatchObject({
        origin: "notification",
        study_day: "2026-10-07",
        correct: 1,
      });
      expect((await detail(page, q.wordId)).familiarity.score).toBe(
        Math.min(30, remindedBefore + 1),
      );
      expect((await detail(page, "apple")).familiarity.score).toBe(30);
      await checkpoint(
        "2026-10-07",
        "25–35分钟随机调度，通知同题回调两次仅一次记分；熟悉词不入被动提醒",
      );
    });

    await test.step("第4天休息：只推进日期和重开应用，不产生学习或补发配额", async () => {
      const factsBefore = personalFacts(profileDir);
      clock.advanceTo("2026-10-08T02:00:00Z");
      await desktop.close();
      desktop = await desktopFactory.start({
        profileDir,
        executablePath,
        poisonHostJava: !!executablePath,
        extraEnv: clock.environment,
      });
      page = desktop.page;
      const rested = await state(page);
      expect(rested.queue.newDone).toBe(0);
      expect(rested.queue.reviewDone).toBe(0);
      expect(rested.queue.newRemaining).toBe(2);
      expect(personalFacts(profileDir).practice).toEqual(factsBefore.practice);
      expect(personalFacts(profileDir).encounters).toEqual(factsBefore.encounters);
      expect((await detail(page, "apple")).note).toBe("第2天记录的联想");
      await checkpoint("2026-10-08", "休息日没有新的学习反馈；重启保留笔记/事件；每日额度不累加");
    });

    await test.step("第5天：目标切换保留个人资料，剪贴板只采集目标命中句子", async () => {
      clock.advanceTo("2026-10-09T02:00:00Z");
      const before = personalFacts(profileDir);
      await openPlan(page, "GMAT 词汇");
      expect(personalFacts(profileDir)).toEqual(before);
      const fixtures = await page.evaluate(async () => {
        const s = await window.leximeet.desktopState();
        const pool = await window.leximeet.desktopQuery({
          scope: "catalog",
          catalogId: s.profile.goal,
          limit: 100,
        });
        const inside = pool.words.find((item) => /^[a-z]+$/.test(item.word)).word;
        const candidates = (
          await window.leximeet.desktopQuery({ scope: "dictionary", offset: 50000, limit: 100 })
        ).words
          .map((row) => row.word)
          .filter((word) => /^[a-z]+$/.test(word));
        const matches = await window.leximeet.desktopQuery({
          kind: "clipboardCandidates",
          words: candidates,
        });
        const known = new Set(matches.matches.map((item) => item.word.toLowerCase()));
        const outside = candidates.find((word) => !known.has(word));
        if (!outside) throw new Error("需要真实公共词典中的目标外单词");
        // 关闭语境去重后仍必须按原操作恢复；不能让七天去重掩盖同 ID 的双写问题。
        await window.leximeet.settings({
          clipboardCaptureEnabled: true,
          clipboardAutoCollect: false,
          captureDuplicateWindowDays: 0,
        });
        return { inside, outside };
      });
      const copied = (text) =>
        desktop.app.evaluate(async (_, text) => {
          process.env.LEXIMEET_TEST_CLIPBOARD_TEXT = text;
          await globalThis.__leximeetTestCapture.poll();
        }, text);
      await copied(`${fixtures.outside} journeyoutsideunknown.`);
      expect(
        (await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot())).items,
      ).toHaveLength(0);
      const actualSentence = `${fixtures.inside.toUpperCase()}, ${fixtures.outside}; reader@example.com, phone=13800138000, token=privatefixturetoken!`;
      await copied(
        `First sentence without our target. ${actualSentence} A final sentence is unrelated.`,
      );
      const notices = (
        await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot())
      ).items;
      const match = notices.find((item) => item.word.toLowerCase() === fixtures.inside);
      expect(match).toBeTruthy();
      // 其余目标词均由本例明确选择不采集，回执夹具只绑定这一条实际 Inbox item。
      await desktop.app.evaluate(
        (_, ids) => {
          for (const id of ids)
            globalThis.__leximeetTestCapture.notification(id).emit("action", { actionIndex: 1 });
        },
        notices.filter((item) => item.id !== match.id).map((item) => item.id),
      );
      const beforeSave = personalFacts(profileDir);
      const scoreBeforeSave = (await detail(page, fixtures.inside)).familiarity.score;
      const notificationsBefore = (await page.evaluate(() => window.leximeet.runtime()))
        .pluginCaptureNotifications.sentCount;
      const fault = await dropFirstClipboardSaveAck(desktop, match.id);
      let saved;
      try {
        await desktop.app.evaluate(
          (_, id) =>
            globalThis.__leximeetTestCapture.notification(id).emit("action", { actionIndex: 0 }),
          match.id,
        );
        await expect
          .poll(
            async () =>
              (
                await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot())
              ).items.find((item) => item.id === match.id)?.status,
          )
          .toBe("failed");
        const failed = await desktop.app.evaluate(() =>
          globalThis.__leximeetTestCapture.snapshot(),
        );
        expect(failed.items).toHaveLength(1);
        expect(failed.items[0]).toMatchObject({
          id: match.id,
          word: match.word,
          context: match.context,
          status: "failed",
          expiresAt: 0,
        });
        expect(failed.error).toContain("执行结果尚未确认");
        const committed = await fault.snapshot();
        expect(committed.dropped).toBe(true);
        expect(committed.calls).toHaveLength(1);
        const original = committed.calls[0];
        expect(original.request).toMatchObject({
          action: "captureClipboard",
          operationId: match.id,
          context: match.context,
        });
        expect(original.confirmed.captureOperationReplayed).toBe(false);
        expect(original.confirmed.captureResult).toMatchObject({
          captureStatus: "created",
          capturePolicy: {
            duplicateWindowDays: 0,
            sensitiveRedactionEnabled: true,
            contextMaxLength: 500,
          },
        });
        const afterCommit = personalFacts(profileDir);
        expect(afterCommit.encounters).toHaveLength(beforeSave.encounters.length + 1);
        const detailAfterCommit = await detail(page, original.request.wordId);
        saved = afterCommit.encounters.find(
          (item) => item.id === original.confirmed.captureResult.entity.entityId,
        );
        // 剪贴板命中给出公共 entryId；遇见表保存物化后的个人 ID，由真实 detail 解引用。
        expect(saved).toMatchObject({ word_id: detailAfterCommit.id, source_title: "系统剪贴板" });
        expect(detailAfterCommit.entryId).toBe(original.request.wordId);
        expect(detailAfterCommit.entry.entry_id).toBe(original.request.wordId);
        expect(original.confirmed.captureResult.entity.data.word).toMatchObject({
          kind: "dictionary",
          entryId: detailAfterCommit.entryId,
          entrySchema: "leximeet.entry.v2",
        });
        expect(afterCommit.encounters.filter((item) => item.id !== saved.id)).toEqual(
          beforeSave.encounters,
        );
        expect(afterCommit.practice).toEqual(beforeSave.practice);
        expect(afterCommit.reviews).toEqual(beforeSave.reviews);
        expect(afterCommit.books).toEqual(beforeSave.books);
        const revisionAfterCommit = workspaceRevision(profileDir);
        expect(detailAfterCommit.familiarity.score).toBe(scoreBeforeSave);
        // 用户显式打开真实失败处理窗口，再点击真实按钮；不直接调用 Inbox.decide。
        await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.openInbox());
        await expect
          .poll(() => desktop.app.windows().some((win) => win.url().endsWith("#capture-inbox")))
          .toBe(true);
        const popup = desktop.app.windows().find((win) => win.url().endsWith("#capture-inbox"));
        const item = popup
          .locator(".capture-notification")
          .filter({ has: popup.getByRole("heading", { name: match.word, exact: true }) });
        await expect(item).toContainText("结果待确认");
        const retryCapture = item.getByRole("button", { name: "重试采集", exact: true });
        await expect(retryCapture).toBeEnabled();
        const clipboardAfter = info.outputPath("evidence", "clipboard-failed-after.png");
        fs.mkdirSync(path.dirname(clipboardAfter), { recursive: true });
        await popup.screenshot({ path: clipboardAfter, animations: "disabled", scale: "css" });
        await info.attach("clipboard-failed-after", {
          path: clipboardAfter,
          contentType: "image/png",
        });
        await retryCapture.click();
        await expect
          .poll(
            async () =>
              (await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot())).items,
          )
          .toEqual([]);
        const recovered = await fault.snapshot();
        expect(recovered.calls).toHaveLength(2);
        expect(recovered.calls[1].request).toEqual(original.request);
        expect(recovered.calls[1].confirmed.captureOperationReplayed).toBe(true);
        expect(recovered.calls[1].confirmed.captureResult).toEqual(
          original.confirmed.captureResult,
        );
        expect(
          personalFacts(profileDir),
          "去重关闭时，未知回执重试也不能重复语境、笔记、词本或学习事实",
        ).toEqual(afterCommit);
        expect(workspaceRevision(profileDir)).toBe(revisionAfterCommit);
        expect(await detail(page, original.request.wordId)).toEqual(detailAfterCommit);
        expect(
          (await page.evaluate(() => window.leximeet.runtime())).pluginCaptureNotifications
            .sentCount,
        ).toBe(notificationsBefore);
        expect(
          (await desktop.app.evaluate(() => globalThis.__leximeetTestCapture.snapshot())).error,
        ).toBe("");
        await popup.evaluate(() => window.leximeetCapture.action({ action: "close" }));
        await attachJson(info, "actual-clipboard-unknown-ack-recovery", {
          failed,
          committed,
          recovered,
          beforeSave,
          afterCommit,
          revisionAfterCommit,
          detailAfterCommit,
          notificationsBefore,
        });
      } catch (error) {
        // 失败也保留实际 HTTP 回执；附件失败不能遮盖原业务断言。
        try {
          await attachJson(info, "clipboard-unknown-ack-failure", await fault.snapshot());
        } catch {}
        throw error;
      } finally {
        await fault.restore();
      }
      expect(saved.context).toContain(fixtures.inside.toUpperCase());
      expect(saved.context).toContain("xxx");
      expect(saved.context).not.toMatch(
        /reader@example\.com|13800138000|privatefixturetoken|First sentence|final sentence/,
      );
      expect(saved.context.length).toBeLessThanOrEqual(500);
      await page.evaluate(() => window.leximeet.settings({ captureDuplicateWindowDays: 7 }));
      await command(page, {
        action: "capture",
        word: fixtures.outside,
        context: `My manual ${fixtures.outside} is outside the current goal.`,
        sourceTitle: "手动额外词",
      });
      await feedback(page, fixtures.outside, "word-list", undefined, "familiar");
      await checkpoint(
        "2026-10-09",
        "目标命中句脱敏；去重关闭时丢失保存回执、原操作显式重试仍只写一次；手动额外词不受目标限制",
      );
    });

    await test.step("第6天：再进入练习、重开和追加笔记，只新增真实答题", async () => {
      clock.advanceTo("2026-10-10T02:00:00Z");
      await page.locator('[data-guide="nav-practice"]').click();
      await page.getByRole("tab", { name: "单词临摹", exact: true }).click();
      const input = page.getByRole("textbox", { name: "练习答案", exact: true });
      const restart = page.getByRole("button", { name: "重新开始", exact: true });
      const factsBeforeRestart = personalFacts(profileDir).practice;
      await restart.click();
      // 重开会按当前目标刷新本模式队列；真实逐字输入必须等到冻结题目和焦点就绪。
      // pressSequentially 不检查可编辑状态，不能把加载期间丢掉的按键误当成业务扣分。
      await expect(restart).toBeEnabled();
      await expect(input).toBeEditable();
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("");
      expect(personalFacts(profileDir).practice).toEqual(factsBeforeRestart);
      const word = (await page.locator(".spelling-letters").innerText()).trim();
      const before = (await detail(page, word)).familiarity.score;
      await input.pressSequentially(word, { delay: 15 });
      await expect
        .poll(async () => (await detail(page, word)).familiarity.score)
        .toBe(Math.min(30, before + 1));
      const factsAfterAnswer = personalFacts(profileDir).practice;
      expect(factsAfterAnswer).toHaveLength(factsBeforeRestart.length + 1);
      expect(factsAfterAnswer.slice(0, -1)).toEqual(factsBeforeRestart);
      expect(factsAfterAnswer.at(-1)).toMatchObject({
        mode: "copy",
        correct: 1,
        study_day: "2026-10-10",
      });
      const currentApple = await detail(page, "apple");
      await command(page, {
        action: "saveNote",
        wordId: "apple",
        note: "第6天继续补充，保留之前归类",
        expectedRevision: currentApple.revision,
      });
      expect((await detail(page, "apple")).books).toHaveLength(1);
      await checkpoint("2026-10-10", "重新开始只清轮次，不回退分数；继续笔记保留词本关系");
    });

    await test.step("第7天：第2天满分的词第一次衰减为29，仍不进入待复习队列", async () => {
      clock.advanceTo("2026-10-11T02:00:00Z");
      const factsBefore = personalFacts(profileDir).practice;
      const apple = await detail(page, "apple");
      expect(apple.familiarity).toMatchObject({ score: 29, status: "mastered" });
      expect((await state(page)).queue.reviews.some((item) => item.word === "apple")).toBe(false);
      expect(personalFacts(profileDir).practice).toEqual(factsBefore);
      // 第3天的真实提醒可能已经练过这个词，不能假定它一直停在第2天的0分。
      const extraBefore = (await detail(page, "journeyextraunknown")).familiarity;
      expect(extraBefore.score).toBeGreaterThanOrEqual(0);
      expect(extraBefore.score).toBeLessThan(20);
      await feedback(page, "journeyextraunknown", "word-list", undefined, "familiar");
      const extraAfter = (await detail(page, "journeyextraunknown")).familiarity;
      expect(extraAfter).toMatchObject({
        score: extraBefore.score + 1,
        status: "learning",
        lastDelta: 1,
      });
      const factsAfter = personalFacts(profileDir).practice;
      expect(factsAfter).toHaveLength(factsBefore.length + 1);
      expect(factsAfter.slice(0, -1)).toEqual(factsBefore);
      expect(factsAfter.at(-1)).toMatchObject({
        mode: "word-list",
        signal: "familiar",
        study_day: "2026-10-11",
      });
      expect(new Set(factsAfter.map((item) => item.id)).size).toBe(factsAfter.length);
      await checkpoint(
        "2026-10-11",
        "30分保护3天再每2天扣1；衰减不是伪造练习事件，不熟悉词可继续学习",
      );
    });
    const facts = personalFacts(profileDir);
    expect([...new Set(facts.practice.map((item) => item.study_day))]).toEqual([
      "2026-10-05",
      "2026-10-06",
      "2026-10-07",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
    await attachJson(info, "seven-real-business-days", {
      daily,
      facts,
      finalState: await state(page),
    });
    expect(desktop.pageErrors).toEqual([]);
  } catch (error) {
    // 先保留实际日期、分数和事务事实，再让原断言失败；诊断异常不得遮盖原错误。
    try {
      await attachJson(info, "seven-days-failure-evidence", {
        daily,
        clock: clock.snapshot(),
        facts: personalFacts(profileDir),
        state: desktop ? await state(desktop.page) : null,
      });
    } catch (diagnosticError) {
      await attachJson(info, "seven-days-diagnostic-error", {
        message: String(diagnosticError.message),
      });
    }
    throw error;
  } finally {
    await audio.close();
  }
});
