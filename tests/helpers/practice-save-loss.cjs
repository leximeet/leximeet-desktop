"use strict";

/**
 * 真实 Core 已确认临摹计分后，仅拒绝一次同题的确认草稿写入。
 * practiceRecord 始终调用原 IPC handler；故障不修改 SQLite、不伪造成功回执。
 * 确认草稿故障发生在转发前，恢复仍须走用户按钮及原提交身份。
 */
async function failFirstConfirmedDraftSave(desktop, wordId) {
  if (typeof wordId !== "string" || !wordId) throw new Error("确认草稿故障必须指定本例真实单词 ID");
  await desktop.app.evaluate(({ ipcMain }, selectedWordId) => {
    if (process.env.LEXIMEET_PROFILE !== "test")
      throw new Error("草稿故障只能注入隔离 test profile");
    const channel = "leximeet:desktopCommand";
    const stateChannel = "leximeet:desktopState";
    const original = ipcMain._invokeHandlers.get(channel);
    const originalState = ipcMain._invokeHandlers.get(stateChannel);
    if (typeof original !== "function" || typeof originalState !== "function")
      throw new Error("未找到真实桌面命令 handler，不能注入草稿写入故障");
    const evidence = { failed: false, records: [], saves: [], stateReads: [] };
    let restored = false;
    const copy = (value) => JSON.parse(JSON.stringify(value));
    function restore() {
      if (restored) return;
      restored = true;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
      ipcMain.removeHandler(stateChannel);
      ipcMain.handle(stateChannel, originalState);
    }
    globalThis.__leximeetConfirmedDraftFault = { evidence, restore };
    // 观察真实 Renderer refresh；不返回替身状态，也不直接操作前端 controller。
    ipcMain.removeHandler(stateChannel);
    ipcMain.handle(stateChannel, async (event, payload) => {
      const response = await originalState(event, payload);
      evidence.stateReads.push({
        succeeded: response?.ok === true,
        guide: copy(response?.value?.guide || null),
        today: response?.value?.today,
      });
      return response;
    });
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      const first = evidence.records[0];
      const sameDraft =
        first &&
        payload?.action === "practiceSave" &&
        payload.wordId === selectedWordId &&
        payload.mode === "copy" &&
        payload.scope === first.request.scope &&
        payload.draft?.attemptId === first.request.attemptId;
      if (sameDraft) {
        const save = { request: copy(payload), forwarded: false, succeeded: false };
        evidence.saves.push(save);
        // 预提交的 pending 草稿仍正常落盘；只拒绝 ACK 后清除 pending 的确认草稿。
        if (
          !evidence.failed &&
          payload.draft.answered === true &&
          payload.draft.pendingSubmission === null
        ) {
          evidence.failed = true;
          return { ok: false, error: "测试确认草稿保存失败：计分已确认，请重试保存原反馈。" };
        }
        save.forwarded = true;
        const response = await original(event, payload);
        save.succeeded = response?.ok === true;
        return response;
      }
      const response = await original(event, payload);
      if (
        payload?.action !== "practiceRecord" ||
        payload.wordId !== selectedWordId ||
        payload.mode !== "copy"
      )
        return response;
      const feedback = response?.value?.practiceFeedback;
      if (
        response?.ok !== true ||
        feedback?.submissionId !== payload.submissionId ||
        feedback.correct !== true
      )
        throw new Error("真实 Core 未确认本例正确临摹，不能冒充计分成功后保存失败");
      evidence.records.push({
        request: copy(payload),
        confirmed: {
          submissionId: feedback.submissionId,
          attemptId: feedback.attemptId,
          correct: feedback.correct,
          effective: feedback.effective,
          duplicate: feedback.duplicate,
          delta: feedback.delta,
        },
      });
      return response;
    });
  }, wordId);
  return {
    snapshot: () => desktop.app.evaluate(() => globalThis.__leximeetConfirmedDraftFault.evidence),
    restore: () => desktop.app.evaluate(() => globalThis.__leximeetConfirmedDraftFault.restore()),
  };
}

/**
 * 暂停指定题型首次草稿的真实 IPC 转发，复现题目已显示、会话尚未就绪的窗口。
 * 放行后仍调用原 handler 落盘；不伪造草稿、计分或教学状态。
 */
async function holdFirstPracticeDraftSave(desktop, mode) {
  if (!["word-list", "copy", "listening", "meaning-choice"].includes(mode))
    throw new Error("草稿等待必须指定本例验证的练习模式");
  await desktop.app.evaluate(({ ipcMain }, selectedMode) => {
    if (process.env.LEXIMEET_PROFILE !== "test")
      throw new Error("草稿等待只能注入隔离 test profile");
    const channel = "leximeet:desktopCommand";
    const original = ipcMain._invokeHandlers.get(channel);
    if (typeof original !== "function") throw new Error("未找到真实桌面命令 handler");
    const evidence = { held: false, forwarded: false, succeeded: false };
    let release;
    let restored = false;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    function restore() {
      if (restored) return;
      restored = true;
      release();
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
    }
    globalThis.__leximeetPracticeDraftGate = { evidence, release, restore };
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      if (evidence.held || payload?.action !== "practiceSave" || payload.mode !== selectedMode)
        return original(event, payload);
      evidence.held = true;
      await gate;
      evidence.forwarded = true;
      const response = await original(event, payload);
      evidence.succeeded = response?.ok === true;
      return response;
    });
  }, mode);
  return {
    snapshot: () => desktop.app.evaluate(() => globalThis.__leximeetPracticeDraftGate.evidence),
    release: () => desktop.app.evaluate(() => globalThis.__leximeetPracticeDraftGate.release()),
    restore: () => desktop.app.evaluate(() => globalThis.__leximeetPracticeDraftGate.restore()),
  };
}

module.exports = { failFirstConfirmedDraftSave, holdFirstPracticeDraftSave };
