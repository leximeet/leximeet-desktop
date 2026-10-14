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

test("桌面未运行时 initialize 返回 DESKTOP_NOT_RUNNING", async () => {
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
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t" } },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(messages[0].error.data.code, "DESKTOP_NOT_RUNNING");
  assert.equal(messages[0].id, 7);
  shim.close();
});

test("stdio 帧拒绝超大 Content-Length", async () => {
  const decoder = new StdioDecoder({ maximum: 64 });
  let failed = "";
  decoder.on("error", (error) => {
    failed = error.message;
  });
  decoder.push(Buffer.from("Content-Length: 1000\r\n\r\n{}", "utf8"));
  assert.equal(failed, "INVALID_FRAME_LENGTH");
});
