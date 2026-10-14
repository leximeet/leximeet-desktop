"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const { encodeStdio, StdioDecoder } = require("../../electron/services/mcp/stdio-framing.cjs");
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
