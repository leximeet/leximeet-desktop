"use strict";

/**
 * 只丢弃一次真实 Core 已提交的列表反馈 ACK；不拦请求，不制造成功回执或改数据库。
 * 故障仅限于本轮隐藏应用的已注册 IPC handler；丢失后立即还原，finally 可再次安全还原。
 */
async function dropFirstWordListAck(desktop) {
  await desktop.app.evaluate(({ ipcMain }) => {
    const channel = "leximeet:desktopCommand";
    const original = ipcMain._invokeHandlers.get(channel);
    if (typeof original !== "function")
      throw new Error("未找到真实桌面命令 handler，不能注入 ACK 故障");
    const evidence = { dropped: false, first: null, confirmed: null };
    globalThis.__leximeetPracticeAckFault = { evidence, restore };
    function restore() {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, original);
    }
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, payload) => {
      const response = await original(event, payload);
      if (payload?.action !== "practiceRecord" || payload.mode !== "word-list" || evidence.dropped)
        return response;
      if (
        response?.ok !== true ||
        response.value?.practiceFeedback?.submissionId !== payload.submissionId
      )
        throw new Error("真实 Core 未确认原事件，不能把失败冒充 ACK 丢失");
      evidence.first = { ...payload };
      const actual = response.value.practiceFeedback;
      evidence.confirmed = {
        submissionId: actual.submissionId,
        attemptId: actual.attemptId,
        correct: actual.correct,
        effective: actual.effective,
        duplicate: actual.duplicate,
      };
      evidence.dropped = true;
      restore();
      return { ok: false, error: "测试丢失回执：已提交结果未知，请重试原反馈。" };
    });
  });
  let restored = false;
  return {
    snapshot: () => desktop.app.evaluate(() => globalThis.__leximeetPracticeAckFault.evidence),
    async restore() {
      if (restored) return;
      await desktop.app.evaluate(() => globalThis.__leximeetPracticeAckFault.restore());
      restored = true;
    },
  };
}

module.exports = { dropFirstWordListAck };
