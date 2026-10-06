"use strict";

/**
 * 本轮隐藏应用中，真实提示反馈已确认后只丢弃一次题目读取回执。
 * 所有请求仍先调用原 IPC handler/Core；不制造答案、成功反馈或 SQLite 事实。
 */
async function dropFirstConfirmedHintRead(desktop) {
  await desktop.app.evaluate(({ ipcMain }) => {
    const commandChannel = "leximeet:desktopCommand";
    const queryChannel = "leximeet:desktopQuery";
    const originalCommand = ipcMain._invokeHandlers.get(commandChannel);
    const originalQuery = ipcMain._invokeHandlers.get(queryChannel);
    if (typeof originalCommand !== "function" || typeof originalQuery !== "function")
      throw new Error("未找到真实练习 IPC handler，不能注入提示读取故障");
    const evidence = { dropped: false, records: [], reads: [] };
    let confirmed;
    let restored = false;
    function restore() {
      if (restored) return;
      restored = true;
      ipcMain.removeHandler(commandChannel);
      ipcMain.handle(commandChannel, originalCommand);
      ipcMain.removeHandler(queryChannel);
      ipcMain.handle(queryChannel, originalQuery);
    }
    globalThis.__leximeetHintReadFault = { evidence, restore };
    ipcMain.removeHandler(commandChannel);
    ipcMain.handle(commandChannel, async (event, payload) => {
      const response = await originalCommand(event, payload);
      if (payload?.action !== "practiceRecord" || payload.signal !== "reveal") return response;
      const feedback = response?.value?.practiceFeedback;
      if (response?.ok !== true || feedback?.submissionId !== payload.submissionId)
        throw new Error("真实 Core 未确认提示反馈，不能冒充成功后读取失败");
      const record = {
        request: {
          wordId: payload.wordId,
          mode: payload.mode,
          attemptId: payload.attemptId,
          submissionId: payload.submissionId,
          signal: payload.signal,
        },
        confirmed: {
          submissionId: feedback.submissionId,
          attemptId: feedback.attemptId,
          delta: feedback.delta,
          effective: feedback.effective,
          duplicate: feedback.duplicate,
          assisted: feedback.assisted,
        },
      };
      evidence.records.push(record);
      confirmed ||= record;
      return response;
    });
    ipcMain.removeHandler(queryChannel);
    ipcMain.handle(queryChannel, async (event, payload) => {
      const response = await originalQuery(event, payload);
      if (
        !confirmed ||
        payload?.kind !== "practiceQuestion" ||
        payload.attemptId !== confirmed.request.attemptId
      )
        return response;
      const question = response?.value;
      if (
        response?.ok !== true ||
        question?.attemptId !== payload.attemptId ||
        question.wordId !== confirmed.request.wordId
      )
        throw new Error("原题目未成功读取，不能用假的读取结果验证恢复");
      evidence.reads.push({
        request: {
          wordId: payload.wordId,
          mode: payload.mode,
          scope: payload.scope,
          cursor: payload.cursor,
          attemptId: payload.attemptId,
        },
        confirmed: {
          wordId: question.wordId,
          word: question.word,
          attemptId: question.attemptId,
          questionId: question.questionId,
          answerVisible: question.answerVisible,
        },
      });
      if (!evidence.dropped) {
        evidence.dropped = true;
        return { ok: false, error: "测试提示读取失败：提示扣分已确认，请重新读取提示。" };
      }
      return response;
    });
  });
  return {
    snapshot: () => desktop.app.evaluate(() => globalThis.__leximeetHintReadFault.evidence),
    restore: () => desktop.app.evaluate(() => globalThis.__leximeetHintReadFault.restore()),
  };
}

module.exports = { dropFirstConfirmedHintRead };
