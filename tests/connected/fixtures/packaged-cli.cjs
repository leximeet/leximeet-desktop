"use strict";
const fs = require("node:fs");
const path = require("node:path");
const gate = require("../../../scripts/lib/connected-readiness.cjs");
const { createCliSession } = require("../../../scripts/lib/connected-cli-worker.cjs");
const controller = new AbortController();
let session;
const stop = (name) => {
  process.exitCode = name === "SIGINT" ? 130 : 143;
  controller.abort(new Error("测试结束本轮 CLI"));
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
const send = (value) =>
  new Promise((resolve, reject) =>
    process.send(value, (error) => (error ? reject(error) : resolve())),
  );
async function main() {
  const prepare = process.env.LEXIMEET_CLI_PREPARE === "1";
  // 与人工 CLI 使用同一 Worker 控制端；只把显示方式切为后台，不能伪造 Native 或浏览器。
  session = createCliSession(
    prepare ? { extensionDir: gate.DEFAULT_EXTENSION } : gate.checkReadiness(),
    {
      signal: controller.signal,
      onStatus: prepare ? console.log : () => {},
      workerOptions: {
        headless: true,
        prepare,
        poisonHostJava: true,
        // 验证正常准备流程时不得复用提供的包；必须在本轮私有资料内构建当前 app。
        ...(prepare ? {} : { packageDirectory: process.env.LEXIMEET_CONNECTED_PACKAGE_ROOT }),
        outputDir: process.env.LEXIMEET_CLI_EVIDENCE,
      },
    },
  );
  await session.ready;
  await send({ type: "ready", value: session.metadata });
  await session.closed;
  await send({
    type: "closed",
    value: JSON.parse(fs.readFileSync(path.join(session.metadata.directory, "acceptance.json"))),
  });
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await session?.close();
    } finally {
      if (process.connected) process.disconnect();
    }
  });
