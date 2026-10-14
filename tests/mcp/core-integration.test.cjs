"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PassThrough } = require("node:stream");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");
const { McpGateway } = require("../../electron/services/mcp/gateway.cjs");
const { runMcpShim } = require("../../electron/mcp-host/main.cjs");
const { encodeStdio, StdioDecoder } = require("../../electron/services/mcp/stdio-framing.cjs");
const { assertTools, expectedSnapshot } = require("../../scripts/mcp/verify-contract.cjs");

const jar = path.resolve(__dirname, "../../core-java/target/leximeet-core.jar");

test(
  "真实 Core + 网关 + shim 完成握手、只读查询并拒绝未授权写入",
  { timeout: 40000 },
  async (t) => {
    assert.ok(fs.existsSync(jar), "请先 npm run build:core");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-it-"));
    const runtime = new JavaRuntime({
      jarPath: jar,
      dataDir: path.join(root, "core"),
      timeout: 20000,
      profile: "test",
    });
    const gateway = new McpGateway({
      core: runtime,
      profile: { root, name: "test" },
      homeDir: path.join(root, "home"),
      awaitReady: async () => {},
    });
    t.after(async () => {
      await gateway.close();
      await runtime.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await runtime.start();
    await gateway.start();
    const input = new PassThrough();
    const output = new PassThrough();
    const decoder = new StdioDecoder();
    const replies = [];
    decoder.on("message", (message) => replies.push(message));
    output.on("data", (data) => decoder.push(data));
    const shim = runMcpShim({
      descriptorPath: gateway.descriptorPath,
      input,
      output,
      diagnostic: new PassThrough(),
      clientId: "cursor",
    });
    t.after(() => shim.close());
    const send = (value) => input.write(encodeStdio(value));
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "it", version: "1.0.1" },
      },
    });
    await waitFor(() => replies.length >= 1);
    assert.equal(replies[0].result.serverInfo.name, "leximeet");
    assert.equal(replies[0].result.protocolVersion, "2025-06-18");
    assert.equal(replies[0].result.serverInfo.title, "词遇");
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    await waitFor(() => replies.length >= 2);
    assertTools(replies[1].result.tools, expectedSnapshot());
    send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "leximeet_help", arguments: {} },
    });
    await waitFor(() => replies.length >= 3);
    assert.equal(replies[3 - 1].result.isError, false);
    send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "leximeet_write",
        arguments: { action: "add_to_vocab", args: { word: "alpha" } },
      },
    });
    await waitFor(() => replies.length >= 4);
    assert.equal(replies[3].result.isError, true);
    assert.equal(replies[3].result.structuredContent.code, "WRITE_NOT_AUTHORIZED");
    const granted = await runtime.request("/api/mcp/manage", "POST", {
      action: "setWriteEnabled",
      enabled: true,
    });
    assert.equal(granted.settings.assistantWriteEnabled, true);
    send({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "leximeet_write",
        arguments: { action: "record_review", args: { word: "alpha" } },
      },
    });
    await waitFor(() => replies.length >= 5);
    assert.equal(replies[4].result.structuredContent.code, "READ_ONLY");
    send({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "not_a_tool", arguments: {} },
    });
    await waitFor(() => replies.length >= 6);
    assert.equal(replies[5].error.code, -32602);
    send({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "leximeet_query",
        arguments: { action: "list_encounters", args: { from: "2026-02-30" } },
      },
    });
    await waitFor(() => replies.length >= 7);
    assert.equal(replies[6].result.isError, true);
    assert.equal(replies[6].result.structuredContent.code, "INVALID_ARGUMENT");
  },
);

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > 15000) {
        clearInterval(timer);
        reject(new Error("等待 MCP 响应超时"));
      }
    }, 20);
  });
}
