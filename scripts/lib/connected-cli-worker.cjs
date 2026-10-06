"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const root = path.resolve(__dirname, "../..");
const { connectedSessionRoot } = require("./connected-session-path.cjs");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const KIND = "leximeet.connected-cli/1";

// Worker 意外退出只处理它已上报的唯一资料根、子进程组和本轮注册；永不按名称清理。
async function recoverOwnedSession(snapshot) {
  if (!snapshot) return;
  const { directory, profileRoot } = snapshot;
  if (
    path.dirname(directory) !== connectedSessionRoot() ||
    !/^[a-f0-9-]{36}$/.test(path.basename(directory)) ||
    profileRoot !== path.join(directory, "desktop") ||
    !fs.existsSync(directory) ||
    fs.realpathSync(directory) !== directory
  )
    throw new Error("拒绝清理不是本轮拥有的资料根");
  const errors = [];
  const pids = new Set(
    [
      ...Object.values(snapshot.processes || {}).map((item) => item.pid),
      snapshot.browser?.pid,
    ].filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid),
  );
  const groupAlive = (pid) => {
    try {
      process.kill(-pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  for (const pid of pids) {
    try {
      if (!groupAlive(pid)) continue;
      process.kill(-pid, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (groupAlive(pid) && Date.now() < deadline) await delay(50);
      if (groupAlive(pid)) process.kill(-pid, "SIGKILL");
      const forceDeadline = Date.now() + 2000;
      while (groupAlive(pid) && Date.now() < forceDeadline) await delay(50);
      if (groupAlive(pid)) throw new Error(`本轮进程组 ${pid} 未退出`);
    } catch (error) {
      errors.push(error.message);
    }
  }
  const registry = path.join(profileRoot, "native-messaging/registrations");
  if (fs.existsSync(registry)) {
    const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
    const {
      unregisterNativeHost,
    } = require("../../electron/services/lmcp/native-registration.cjs");
    for (const name of fs.readdirSync(registry).filter((name) => name.endsWith(".json"))) {
      try {
        const registration = readPrivateJson(path.join(registry, name));
        if (registration.profileRoot !== profileRoot) throw new Error("注册不属于本轮资料");
        unregisterNativeHost(registration);
      } catch (error) {
        errors.push(error.message);
      }
    }
  }
  fs.writeFileSync(
    path.join(directory, "worker-exit.json"),
    JSON.stringify(
      {
        unexpected: true,
        at: new Date().toISOString(),
        pids: [...pids],
        cleanupErrors: errors,
        focusComplete: false,
        dataRetained: true,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  if (errors.length) throw new Error(`Worker 退出恢复失败：${errors.join("；")}`);
}

// CLI 控制端不加载 Playwright，只转交有限命令并等待 Worker 清理确认。
function createCliSession(
  checked,
  {
    signal,
    onStatus = console.log,
    workerFile = __filename,
    workerOptions = {},
    recover = recoverOwnedSession,
    closeTimeoutMs = 120000,
  } = {},
) {
  const worker = new Worker(workerFile, {
    workerData: {
      kind: KIND,
      checked,
      options: { headless: false, ...workerOptions },
    },
  });
  let metadata,
    stopping = false,
    finished = false,
    readyDone = false,
    acknowledged = false,
    acknowledgmentError,
    closeTimer,
    sequence = 0;
  const requests = new Map();
  let resolveReady, rejectReady, resolveClosed, rejectClosed;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const closed = new Promise((resolve, reject) => {
    resolveClosed = resolve;
    rejectClosed = reject;
  });
  void ready.catch(() => {});
  void closed.catch(() => {});
  const errorFrom = (value) =>
    Object.assign(new Error(value?.message || "Worker 连接会话失败"), {
      code: value?.code,
    });
  const settle = (error) => {
    if (finished) return;
    finished = true;
    clearTimeout(closeTimer);
    signal?.removeEventListener("abort", onAbort);
    for (const request of requests.values())
      request.reject(
        error ||
          Object.assign(new Error("本轮连接会话已结束"), {
            code: "LAB_CLOSING",
          }),
      );
    requests.clear();
    if (!readyDone) rejectReady(error || signal?.reason || new Error("启动前会话已关闭"));
    error ? rejectClosed(error) : resolveClosed();
  };
  const request = (command) => {
    if (stopping || finished)
      return Promise.reject(Object.assign(new Error("本轮环境正在结束"), { code: "LAB_CLOSING" }));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      requests.set(id, { resolve, reject });
      worker.postMessage({ type: "command", id, command });
    });
  };
  const close = () => {
    if (!stopping && !finished) {
      stopping = true;
      worker.postMessage({ type: "close" });
      closeTimer = setTimeout(() => {
        workerError = new Error("连接 Worker 退出超时，清理自有进程并保留本轮资料");
        void worker.terminate();
      }, closeTimeoutMs);
    }
    return closed;
  };
  const onAbort = () => {
    void close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  worker.on("message", (message) => {
    if (message.type === "metadata") metadata = message.value;
    else if (message.type === "status") onStatus(message.value);
    else if (message.type === "ready") {
      readyDone = true;
      resolveReady(session);
    } else if (message.type === "result") {
      const pending = requests.get(message.id);
      if (!pending) return;
      requests.delete(message.id);
      message.error ? pending.reject(errorFrom(message.error)) : pending.resolve();
    } else if (message.type === "closed") {
      acknowledged = true;
      acknowledgmentError = message.error ? errorFrom(message.error) : null;
      // ACK 后也等线程自然退出，不能把随后崩溃或残留句柄伪报为清理完成。
      closeTimer ||= setTimeout(() => {
        workerError = new Error("连接 Worker 确认后仍未退出");
        void worker.terminate();
      }, closeTimeoutMs);
    }
  });
  let workerError;
  worker.on("error", (error) => {
    workerError = error;
  });
  worker.on("exit", (code) => {
    if (finished) return;
    if (acknowledged && code === 0 && !workerError) return settle(acknowledgmentError);
    const failure = workerError || new Error(`连接 Worker 意外退出（${code}），保留本轮资料`);
    void recover(metadata).then(
      () => settle(failure),
      (error) => settle(new AggregateError([failure, error], "Worker 意外退出且退出恢复失败")),
    );
  });
  const session = {
    ready,
    closed,
    close,
    headless: false,
    get metadata() {
      return metadata;
    },
    stopDesktop: () => request("stopDesktop"),
    restartDesktop: () => request("restartDesktop"),
  };
  if (signal?.aborted) onAbort();
  return session;
}

async function runWorker() {
  const controller = new AbortController();
  let session,
    startup,
    work = Promise.resolve(),
    closing;
  const send = (value) => parentPort.postMessage(value);
  const failure = (error) => ({ message: error.message, code: error.code });
  const finish = (reason) => {
    if (closing) return closing;
    closing = (async () => {
      let error;
      try {
        await startup;
      } catch (cause) {
        if (cause !== controller.signal.reason) error = cause;
      }
      try {
        await session?.close(reason);
      } catch (cause) {
        error ||= cause;
      }
      send({ type: "closed", ...(error ? { error: failure(error) } : {}) });
      parentPort.close();
    })();
    return closing;
  };
  parentPort.on("message", (message) => {
    if (message.type === "close") {
      controller.abort(new Error("本轮验收已取消"));
      void finish("cancelled");
    } else if (message.type === "command") {
      work = work
        .catch(() => {})
        .then(async () => {
          try {
            if (closing || !session || !["stopDesktop", "restartDesktop"].includes(message.command))
              throw Object.assign(new Error("本轮连接会话尚未就绪或正在结束"), {
                code: "LAB_CLOSING",
              });
            await session[message.command]();
            send({ type: "result", id: message.id });
          } catch (error) {
            send({ type: "result", id: message.id, error: failure(error) });
          }
        });
    }
  });
  startup = (async () => {
    session = await require("../accept-connected.cjs").startPackagedLab(workerData.checked, {
      ...workerData.options,
      signal: controller.signal,
      onStatus: (value) => send({ type: "status", value }),
      onRecord: (value) => send({ type: "metadata", value }),
      beforeClose: () => work,
    });
    if (controller.signal.aborted) throw controller.signal.reason;
    send({ type: "ready" });
    void session.closed.then(
      () => finish("browser-closed"),
      () => finish("cleanup-failure"),
    );
  })();
  void startup.catch(() => finish("startup-error"));
}
if (!isMainThread && workerData?.kind === KIND) void runWorker();
module.exports = { createCliSession, recoverOwnedSession };
