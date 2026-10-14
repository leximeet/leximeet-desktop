"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const {
  verifyContract,
  expectedSnapshot,
  assertTools,
} = require("../../scripts/mcp/verify-contract.cjs");
const { encodeStdio, StdioDecoder } = require("../../electron/services/mcp/stdio-framing.cjs");

test("冻结快照含四件路由式工具且写入非只读", () => {
  const snapshot = verifyContract();
  assert.equal(
    snapshot.tools.map((tool) => tool.name).join(","),
    "leximeet_help,leximeet_describe,leximeet_query,leximeet_write",
  );
  assert.equal(snapshot.tools[3].annotations.readOnlyHint, false);
});

test("MCP SDK 风格客户端能读取 schema 快照", async () => {
  const snapshot = expectedSnapshot();
  const input = new PassThrough();
  const output = new PassThrough();
  const decoder = new StdioDecoder();
  const replies = [];
  decoder.on("message", (message) => {
    replies.push(message);
    if (message.method === "initialize") {
      output.write(
        encodeStdio({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: snapshot.protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: snapshot.serverInfo,
          },
        }),
      );
    }
    if (message.method === "tools/list") {
      output.write(
        encodeStdio({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: snapshot.tools.map((tool) => ({
              name: tool.name,
              description: tool.name,
              inputSchema: { type: "object", properties: {} },
              annotations: tool.annotations,
            })),
          },
        }),
      );
    }
  });
  input.on("data", (data) => decoder.push(data));
  const clientDecoder = new StdioDecoder();
  const results = [];
  clientDecoder.on("message", (message) => results.push(message));
  output.on("data", (data) => clientDecoder.push(data));
  input.write(
    encodeStdio({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "sdk" } },
    }),
  );
  input.write(encodeStdio({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assertTools(results[1].result.tools, snapshot);
});
