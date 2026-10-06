"use strict";
const { test, expect } = require("../helpers/electron-fixture.cjs");

// 只替换 OS 投递；出题、Main 回调、IPC 刷新及 SQLite 均为真实实现。
test("系统通知固定题目、回答幂等、忽略不记分且不弹出练习窗口", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start(),
    page = desktop.page;
  await page.getByRole("button", { name: "跳过教学", exact: true }).click();
  await page.evaluate(async () => {
    for (const word of ["apple", "orange"])
      await window.leximeet.desktopCommand({
        action: "capture",
        word,
        context: `I see an ${word}.`,
      });
  });
  expect(await desktop.app.evaluate(() => globalThis.__leximeetTestStudy.issue())).toBe(true);
  const pending = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "reminderQuestions" }),
  );
  const question = pending.questions[0];
  expect(question.mode).toBe("meaning-choice");
  // 多义词用题目冻结的完整释义；第一义项不一定代表词头摘要。
  expect(question.meaning).toBeTruthy();
  const button = question.options.findIndex((option) => option.text === question.meaning);
  expect(button).toBeGreaterThanOrEqual(0);
  expect(question.options.every((option) => option.id !== question.wordId)).toBe(true);
  // 通知正文点击属于真实业务入口；后台投递替身不能借此显示主窗口。
  await desktop.app.evaluate(
    (_, id) => globalThis.__leximeetTestStudy.notice(id).emit("click"),
    question.id,
  );
  expect(
    await desktop.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((win) => win.isVisible() || win.isFocused()),
    ),
  ).toBe(false);
  await desktop.app.evaluate(
    (_, { id, button }) => {
      const notice = globalThis.__leximeetTestStudy.notice(id);
      notice.emit("action", { actionIndex: button });
      notice.emit("action", { actionIndex: button });
    },
    { id: question.id, button },
  );
  await expect
    .poll(() =>
      page.evaluate(() => window.leximeet.desktopState()).then((state) => state.insights.practice),
    )
    .toBe(1);
  const detail = await page.evaluate(
    (wordId) => window.leximeet.desktopQuery({ kind: "detail", wordId }),
    question.wordId,
  );
  expect(detail.familiarity.score).toBe(11);
  expect(detail.familiarity.ruleVersion).toBe("leximeet.learning/2");
  const duplicate = await page.evaluate(
    (q) =>
      window.leximeet.desktopCommand({
        action: "answerReminderQuestion",
        questionId: q.id,
        choiceId: q.choiceId,
      }),
    { id: question.id, choiceId: question.options[button].id },
  );
  expect(duplicate.duplicate).toBe(true);
  await desktop.app.evaluate(() => globalThis.__leximeetTestStudy.issue());
  const next = await page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "reminderQuestions" }),
  );
  await desktop.app.evaluate(
    (_, id) => globalThis.__leximeetTestStudy.notice(id).emit("close"),
    next.questions[0].id,
  );
  expect((await page.evaluate(() => window.leximeet.desktopState())).insights.practice).toBe(1);
  expect(desktop.app.windows()).toHaveLength(1);
  expect(desktop.pageErrors).toEqual([]);
});
