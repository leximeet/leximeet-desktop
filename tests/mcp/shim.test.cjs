"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { encodeStdio, StdioDecoder } = require("../../electron/services/mcp/stdio-framing.cjs");
const { writePrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
const { runMcpShim } = require("../../electron/mcp-host/main.cjs");

function collect(stream) {
  const decoder = new StdioDecoder();
  const messages = [];
  decoder.on("message", (message) => messages.push(message));
  stream.on("data", (data) => decoder.push(data));
  return messages;
}

test("桌面未运行时 initialize 仍成功，工具调用才返回 DESKTOP_NOT_RUNNING", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = collect(output);
  const shim = runMcpShim({
    descriptorPath: "",
    pointerPath: "/tmp/leximeet-mcp-missing-pointer.json",
    input,
    output,
    diagnostic: new PassThrough(),
  });
  input.write(
    encodeStdio({
      jsonrpc: "2.0",
      id: 7,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages[0].result.serverInfo.name, "leximeet");
  assert.equal(messages[0].result.protocolVersion, "2025-06-18");
  input.write(
    encodeStdio({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: { name: "leximeet_help", arguments: {} },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages[1].error.data.code, "DESKTOP_NOT_RUNNING");
  assert.equal(messages[1].id, 8);
  shim.close();
});

test("陈旧套接字拒绝连接时 initialize 仍本地完成", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-stale-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const socketDir = path.join(root, "sockets");
  fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(socketDir, 0o700);
  const socketPath = path.join(socketDir, "mcp.sock");
  const leftover = net.createServer();
  await new Promise((resolve) => leftover.listen(socketPath, resolve));
  fs.chmodSync(socketPath, 0o600);
  leftover.close();
  await new Promise((resolve) => leftover.once("close", resolve));
  const descriptorPath = path.join(root, "mcp-uds.json");
  writePrivateJson(descriptorPath, {
    format: "leximeet.mcp-uds/1",
    token: "ab".repeat(32),
    socketPath,
    instanceId: "stale-instance",
  });
  const input = new PassThrough();
  const output = new PassThrough();
  const messages = collect(output);
  const started = Date.now();
  const shim = runMcpShim({
    descriptorPath,
    input,
    output,
    diagnostic: new PassThrough(),
    connectTimeoutMs: 4000,
  });
  t.after(() => shim.close());
  input.write(
    encodeStdio({
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
    }),
  );
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (messages.length) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      resolve();
    }, 800);
  });
  assert.equal(messages[0]?.result?.serverInfo?.name, "leximeet");
  assert.equal(messages[0].result.protocolVersion, "2025-06-18");
  assert.ok(Date.now() - started < 1500, "不得等到连接超时才握手");
});

test("stdio 使用换行分隔的 JSON，拒绝超长行", async () => {
  const encoded = encodeStdio({ jsonrpc: "2.0", id: 1, method: "ping" });
  assert.equal(encoded.includes(0x0a), true);
  assert.doesNotMatch(encoded.toString("utf8"), /Content-Length/);
  const decoder = new StdioDecoder();
  const messages = [];
  decoder.on("message", (message) => messages.push(message));
  decoder.push(Buffer.from('{"jsonrpc":"2.0","id":3,"method":"ping"}\n', "utf8"));
  assert.equal(messages[0].id, 3);
  const limited = new StdioDecoder({ maximum: 16 });
  let failed = "";
  limited.on("error", (error) => {
    failed = error.message;
  });
  limited.push(Buffer.from(`${"x".repeat(32)}\n`, "utf8"));
  assert.equal(failed, "INVALID_FRAME_LENGTH");
});
