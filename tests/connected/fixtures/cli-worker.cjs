"use strict";
const { parentPort, workerData } = require("node:worker_threads");
const options = workerData.options;
// 只模拟控制通道生命周期；真实 app、Native Host 和业务断言由包级套件验证。
if (options.fixture === "crash") {
  parentPort.postMessage({
    type: "metadata",
    value: {
      directory: options.directory,
      profileRoot: options.profileRoot,
      processes: { owned: { pid: options.ownedPid } },
    },
  });
  setTimeout(() => process.exit(7), 20);
} else {
  if (options.fixture !== "cancel-startup") parentPort.postMessage({ type: "ready" });
  parentPort.on("message", (message) => {
    if (message.type === "command") parentPort.postMessage({ type: "result", id: message.id });
    if (message.type === "close") {
      setTimeout(() => {
        parentPort.postMessage({
          type: "closed",
          ...(options.fixture === "cleanup-error" ? { error: { message: "真实清理失败" } } : {}),
        });
        if (options.fixture === "ack-crash") process.exit(9);
        else parentPort.close();
      }, 30);
    }
  });
}
