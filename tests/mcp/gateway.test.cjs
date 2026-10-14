"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { McpGateway } = require("../../electron/services/mcp/gateway.cjs");
const { FrameDecoder, encodeFrame } = require("../../electron/services/lmcp/framing.cjs");
const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");

async function fixture(
  t,
  request = async () => ({ message: { jsonrpc: "2.0", id: 1, result: { ok: true } } }),
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-gateway-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const gateway = new McpGateway({
    core: { request },
    profile: { root, name: "test" },
    homeDir: home,
    awaitReady: async () => {},
  });
  t.after(async () => {
    await gateway.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.LEXIMEET_MCP_WRITE_POINTER = "1";
  await gateway.start();
  return { gateway, home };
}

test("描述符不含 Core 令牌，错误令牌被拒绝", async (t) => {
  const { gateway } = await fixture(t);
  const descriptor = readPrivateJson(gateway.descriptorPath);
  assert.equal(descriptor.format, "leximeet.mcp-uds/1");
  assert.doesNotMatch(JSON.stringify(descriptor), /Bearer|127\.0\.0\.1/);
  const socket = net.connect(descriptor.socketPath);
  const decoder = new FrameDecoder();
  const inbox = [];
  decoder.on("message", (message) => inbox.push(message));
  socket.on("data", (data) => decoder.push(data));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(encodeFrame({ kind: "transport-auth", token: "deadbeef", clientId: "cursor" }));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(inbox.length, 0);
  socket.destroy();
});

async function authedSession(gateway, clientId = "cursor") {
  const descriptor = readPrivateJson(gateway.descriptorPath);
  const socket = net.connect(descriptor.socketPath);
  const decoder = new FrameDecoder();
  const inbox = [];
  decoder.on("message", (message) => inbox.push(message));
  socket.on("data", (data) => decoder.push(data));
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(encodeFrame({ kind: "transport-auth", token: descriptor.token, clientId }));
  await new Promise((resolve) => {
    const timer = setInterval(() => {
      if (inbox.some((item) => item.kind === "transport-ready")) {
        clearInterval(timer);
        resolve();
      }
    }, 10);
  });
  return { socket, inbox };
}

test("转发固定使用握手时的 session.clientId，并实现超时与 tools/call 限流", async (t) => {
  const seen = [];
  const { gateway } = await fixture(t, async (_path, _method, body) => {
    seen.push(body);
    return { message: { jsonrpc: "2.0", id: body.message.id, result: { ok: true } } };
  });
  gateway.rateLimitPerMinute = 1;
  gateway.forwardTimeoutMs = 40;
  const { socket, inbox } = await authedSession(gateway, "cursor");
  socket.write(
    encodeFrame({
      kind: "mcp-request",
      clientId: "spoofed",
      message: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(seen[0].clientId, "cursor");
  socket.write(
    encodeFrame({
      kind: "mcp-request",
      message: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "leximeet_help" } },
    }),
  );
  socket.write(
    encodeFrame({
      kind: "mcp-request",
      message: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "leximeet_help" } },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    inbox.some((item) => item.message?.error?.data?.code === "RATE_LIMITED"),
    true,
  );
  socket.destroy();
});

test("转发超时返回 FORWARD_TIMEOUT", async (t) => {
  const { gateway } = await fixture(t, async () => new Promise(() => {}));
  gateway.forwardTimeoutMs = 30;
  const { socket, inbox } = await authedSession(gateway);
  socket.write(
    encodeFrame({
      kind: "mcp-request",
      message: { jsonrpc: "2.0", id: 9, method: "ping", params: {} },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(
    inbox.some((item) => item.message?.error?.data?.code === "FORWARD_TIMEOUT"),
    true,
  );
  socket.destroy();
});

test("畸形帧断开且不转发到 Core", async (t) => {
  let called = 0;
  const { gateway } = await fixture(t, async () => {
    called++;
    return { message: { jsonrpc: "2.0", id: 1, result: {} } };
  });
  const descriptor = readPrivateJson(gateway.descriptorPath);
  const socket = net.connect(descriptor.socketPath);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(Buffer.from("not-a-frame"));
  await new Promise((resolve) => socket.once("close", resolve));
  assert.equal(called, 0);
});
