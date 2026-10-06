"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JavaRuntime, requestBudget } = require("../../electron/services/java-runtime.cjs");
test("正式环境拒绝测试业务时钟且不创建运行副本或启动 Java", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-clock-negative-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const jar = path.join(root, "unused.jar");
  fs.writeFileSync(jar, "test");
  for (const profile of ["local", "dev", "demo"]) {
    const dataDir = path.join(root, profile);
    const runtime = new JavaRuntime({
      jarPath: jar,
      dataDir,
      profile,
      testClockFile: path.join(dataDir, "test-clock.json"),
    });
    await assert.rejects(() => runtime.start(), /隔离 test/);
    assert.equal(runtime.child, null);
    assert.equal(fs.existsSync(dataDir), false);
  }
});
test("LMCP 读写预算有界，本机查询独立", () => {
  assert.equal(
    requestBudget("/api/lmcp/rpc", {
      envelope: { method: "recordEncounter" },
    }),
    15000,
  );
  assert.equal(
    requestBudget("/api/lmcp/rpc", {
      envelope: { method: "openInDesktop" },
    }),
    15000,
  );
  assert.equal(requestBudget("/api/lmcp/rpc", { envelope: { method: "getWord" } }), 5000);
  assert.equal(requestBudget("/api/lmcp/rpc", { envelope: { method: "pair" } }), 5000);
  assert.equal(requestBudget("/api/desktop/query"), 15000);
});
test("超时不能误报Core崩溃，原调用保持唯一且显式未知", async (t) => {
  const original = global.fetch;
  let count = 0;
  t.after(() => (global.fetch = original));
  global.fetch = async () => {
    count++;
    throw new DOMException("timeout", "TimeoutError");
  };
  const runtime = new JavaRuntime({
    jarPath: "/unused.jar",
    dataDir: "/unused",
  });
  runtime.port = 43199;
  runtime.token = "test-private";
  runtime.state = "ready";
  await assert.rejects(
    () =>
      runtime.request("/api/lmcp/rpc", "POST", {
        envelope: { method: "recordEncounter" },
      }),
    (error) => error.code === "DEADLINE_EXCEEDED",
  );
  assert.equal(count, 1);
  assert.equal(runtime.state, "ready");
});
