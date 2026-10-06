"use strict";

/**
 * 只在本例隐藏测试应用中丢失一次剪贴板保存回执。
 * 原 fetch 必须先完成真实 Core 事务；随后模拟响应超时，不改请求、答案或数据库。
 */
async function dropFirstClipboardSaveAck(desktop, operationId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(operationId))
    throw new Error("剪贴板故障夹具必须绑定本轮 Inbox 的真实操作 ID");
  await desktop.app.evaluate((_, operationId) => {
    if (process.env.LEXIMEET_PROFILE !== "test" || !globalThis.__leximeetTestCapture)
      throw new Error("只能在隔离的隐藏测试应用中注入剪贴板回执丢失");
    const originalFetch = globalThis.fetch;
    if (typeof originalFetch !== "function") throw new Error("未找到真实 Core HTTP 客户端");
    const evidence = { operationId, dropped: false, calls: [] };
    let restored = false;
    globalThis.__leximeetClipboardAckFault = {
      evidence,
      restore() {
        if (restored) return;
        restored = true;
        globalThis.fetch = originalFetch;
      },
    };
    globalThis.fetch = async function (...args) {
      const response = await originalFetch.apply(this, args);
      const [input, options] = args;
      const address =
        typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
      if (typeof address !== "string") return response;
      const url = new URL(address);
      if (
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/api/desktop/command" ||
        options?.method !== "POST"
      )
        return response;
      const request = typeof options.body === "string" ? JSON.parse(options.body) : null;
      if (request?.action !== "captureClipboard" || request.operationId !== operationId)
        return response;
      const actual = await response.clone().json();
      if (
        !response.ok ||
        actual.captureResult?.captureStatus !== "created" ||
        !actual.captureResult.entity?.entityId
      )
        throw new Error("真实 Core 尚未确认剪贴板保存成功，不能冒充提交后丢失回执");
      // 不保存认证请求头、Core token 或整个工作区，只记录本例的安全语境和真实回执。
      evidence.calls.push({
        request: {
          action: request.action,
          operationId: request.operationId,
          goal: request.goal,
          wordId: request.wordId,
          context: request.context,
        },
        confirmed: {
          captureOperationReplayed: actual.captureOperationReplayed === true,
          captureResult: actual.captureResult,
        },
      });
      if (!evidence.dropped) {
        evidence.dropped = true;
        const error = new Error("测试剪贴板保存回执丢失：真实 Core 已提交原操作");
        // 与真实 HTTP 超时共用 JavaRuntime 的未知结果路径，不谎称核心进程已失联。
        error.name = "TimeoutError";
        throw error;
      }
      return response;
    };
  }, operationId);
  return {
    snapshot: () => desktop.app.evaluate(() => globalThis.__leximeetClipboardAckFault.evidence),
    restore: () => desktop.app.evaluate(() => globalThis.__leximeetClipboardAckFault.restore()),
  };
}

module.exports = { dropFirstClipboardSaveAck };
