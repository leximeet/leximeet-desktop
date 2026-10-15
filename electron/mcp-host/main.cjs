"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { FrameDecoder, FrameWriter } = require("../services/lmcp/framing.cjs");
const { readPrivateJson } = require("../services/lmcp/private-files.cjs");
const { encodeStdio, StdioDecoder } = require("../services/mcp/stdio-framing.cjs");
const { mcpPointerPath } = require("../services/platform/app-paths.cjs");
const { parseDescriptor, connectEndpoint } = require("../services/platform/transport.cjs");

const INSTRUCTIONS =
  "先调用 leximeet_help 查看能力分组，再用 leximeet_describe 读取该组参数。" +
  "只读查询一律走 leximeet_query；唯一写入是 leximeet_write 的 add_to_vocab，默认关闭，需用户在桌面设置中授权。";
const KNOWN_PROTOCOLS = new Set(["2025-06-18", "2025-03-26", "2024-11-05"]);

/**
 * 薄 stdio 转发：AI 客户端只配置稳定启动脚本，不放 Core 令牌或端口。
 * initialize / ping / tools/list 在桌面未开时本地成功；工具调用再返回 DESKTOP_NOT_RUNNING。
 */
function defaultPointerPath(homeDir = os.homedir()) {
  return mcpPointerPath({ homeDir });
}

function resolveDescriptorPath({
  descriptorPath = process.env.LEXIMEET_MCP_DESCRIPTOR,
  pointerPath = process.env.LEXIMEET_MCP_POINTER,
  homeDir = os.homedir(),
} = {}) {
  if (descriptorPath) return descriptorPath;
  const pointer = pointerPath || defaultPointerPath(homeDir);
  if (!fs.existsSync(pointer)) return "";
  const current = readPrivateJson(pointer);
  if (current.format !== "leximeet.mcp-pointer/1" || !path.isAbsolute(current.descriptorPath || ""))
    throw new Error("SOURCE_REJECTED");
  return current.descriptorPath;
}

function desktopNotRunning(id) {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code: -32000,
      message: "DESKTOP_NOT_RUNNING: 词遇桌面未运行，请先打开应用后再试。",
      data: { code: "DESKTOP_NOT_RUNNING" },
    },
  };
}

function negotiateProtocol(requested) {
  return KNOWN_PROTOCOLS.has(requested) ? requested : "2025-06-18";
}

function localInitialize(id, params) {
  const protocol = negotiateProtocol(params?.protocolVersion || "");
  const serverInfo = { name: "leximeet", version: "1.0.2" };
  if (protocol === "2025-06-18") serverInfo.title = "词遇";
  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: protocol,
      capabilities: { tools: { listChanged: false } },
      serverInfo,
      instructions: INSTRUCTIONS,
    },
  };
}

function localToolsList(id, protocol) {
  const annotations = protocol === "2024-11-05" ? undefined : { readOnlyHint: true };
  const writeAnnotations = protocol === "2024-11-05" ? undefined : { readOnlyHint: false };
  const tools = [
    {
      name: "leximeet_help",
      description: "列出词典、单词本、复习查询与统计四组能力。",
      inputSchema: { type: "object", properties: {} },
      annotations,
    },
    {
      name: "leximeet_describe",
      description: "按分组返回该组各个 action 的参数说明。",
      inputSchema: {
        type: "object",
        properties: { group: { type: "string" } },
        required: ["group"],
      },
      annotations,
    },
    {
      name: "leximeet_query",
      description: "只读统一入口。",
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string" },
          args: { type: "object" },
          detail: { type: "boolean" },
        },
        required: ["action"],
      },
      annotations,
    },
    {
      name: "leximeet_write",
      description: "唯一写入入口，目前只有 add_to_vocab。",
      inputSchema: {
        type: "object",
        properties: { action: { type: "string" }, args: { type: "object" } },
        required: ["action"],
      },
      annotations: writeAnnotations,
    },
  ].map((tool) => {
    if (!tool.annotations) delete tool.annotations;
    return tool;
  });
  return { jsonrpc: "2.0", id, result: { tools } };
}

function hasId(message) {
  return Boolean(message && Object.hasOwn(message, "id") && message.id !== null);
}

function runMcpShim({
  descriptorPath,
  pointerPath,
  homeDir = os.homedir(),
  clientId = process.env.LEXIMEET_MCP_CLIENT || "unknown",
  input = process.stdin,
  output = process.stdout,
  diagnostic = process.stderr,
  connectTimeoutMs = 5000,
} = {}) {
  let socket;
  let socketWriter;
  let ready = false;
  let connectedPath = "";
  let stopped = false;
  let timer;
  let protocol = "2025-06-18";
  const pending = [];
  const finish = (code = "", failed = false) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    input.pause();
    input.destroy();
    dropSocket();
    if (code) diagnostic.write(`LEXIMEET_MCP_${code}\n`);
    if (failed) process.exitCode = 1;
  };
  const write = (value) => {
    try {
      output.write(encodeStdio(value));
    } catch {
      finish("STDOUT_CLOSED", true);
    }
  };
  const dropSocket = () => {
    clearTimeout(timer);
    socketWriter?.close();
    socket?.destroy();
    socketWriter = undefined;
    socket = undefined;
    ready = false;
    connectedPath = "";
  };
  const readDescriptor = () => {
    try {
      const resolved = resolveDescriptorPath({ descriptorPath, pointerPath, homeDir });
      if (!resolved) return null;
      if (!path.isAbsolute(resolved)) throw new Error("SOURCE_REJECTED");
      const descriptor = parseDescriptor(readPrivateJson(resolved));
      if (!/^[a-f0-9]{64}$/.test(descriptor.token || "")) throw new Error("SOURCE_REJECTED");
      return descriptor;
    } catch (error) {
      if (error?.message) diagnostic.write(`${error.message}\n`);
      const code = ["SOURCE_REJECTED", "UNSAFE_SOCKET"].includes(error.message)
        ? error.message
        : "HOST_UNAVAILABLE";
      diagnostic.write(`LEXIMEET_MCP_${code}\n`);
      return null;
    }
  };
  const replyLocal = (message) => {
    if (message.method === "initialize") {
      protocol = negotiateProtocol(message.params?.protocolVersion || "");
      write(localInitialize(message.id, message.params));
      return;
    }
    if (message.method === "ping") {
      write({ jsonrpc: "2.0", id: message.id, result: {} });
      return;
    }
    if (message.method === "tools/list") {
      write(localToolsList(message.id, protocol));
      return;
    }
    write(desktopNotRunning(message.id));
  };
  const flushPending = () => {
    while (pending.length && socketWriter && ready) {
      socketWriter.send({ kind: "mcp-request", clientId, message: pending.shift() });
    }
  };
  const rejectOrLocal = () => {
    while (pending.length) {
      const message = pending.shift();
      if (!hasId(message)) continue;
      replyLocal(message);
    }
  };
  // 未就绪时套接字被拒/断开：清连接后走本地握手，避免 initialize 一直挂起。
  const abandonConnect = () => {
    const wasReady = ready;
    dropSocket();
    if (!wasReady) rejectOrLocal();
  };
  const attachSocket = (descriptor) => {
    dropSocket();
    try {
      socket = connectEndpoint(descriptor);
    } catch {
      // 描述符仍在但端点已失效（陈旧 UDS / 管道），走本地握手。
      return false;
    }
    connectedPath = descriptor.path;
    socketWriter = new FrameWriter(socket, { onError: () => finish("BACKPRESSURE_LIMIT", true) });
    const fromDesktop = new FrameDecoder();
    timer = setTimeout(abandonConnect, connectTimeoutMs);
    timer.unref();
    socket.on("connect", () =>
      socketWriter.send({ kind: "transport-auth", token: descriptor.token, clientId }),
    );
    fromDesktop.on("message", (message) => {
      if (!ready) {
        if (message?.kind !== "transport-ready" || message.instanceId !== descriptor.instanceId) {
          abandonConnect();
          return;
        }
        ready = true;
        clearTimeout(timer);
        flushPending();
        return;
      }
      if (message?.kind === "mcp-response" && message.message) write(message.message);
    });
    fromDesktop.on("error", () => finish("INVALID_FRAME", true));
    socket.on("data", (data) => fromDesktop.push(data));
    socket.on("end", () => {
      fromDesktop.finish();
      abandonConnect();
    });
    socket.on("error", () => abandonConnect());
    socket.on("close", () => {
      if (connectedPath === descriptor.path) abandonConnect();
    });
    return true;
  };
  const ensureConnected = () => {
    const descriptor = readDescriptor();
    if (!descriptor) {
      dropSocket();
      return false;
    }
    if (socket && !socket.destroyed && ready && connectedPath === descriptor.path) return true;
    return attachSocket(descriptor);
  };
  const fromClient = new StdioDecoder();
  fromClient.on("message", (message) => {
    if (stopped) return;
    if (message?.method === "initialize" && message.params?.protocolVersion)
      protocol = negotiateProtocol(message.params.protocolVersion);
    const online = ensureConnected();
    if (!hasId(message)) {
      if (online && ready && socketWriter)
        socketWriter.send({ kind: "mcp-request", clientId, message });
      return;
    }
    if (!online) {
      replyLocal(message);
      return;
    }
    if (!ready) {
      pending.push(message);
      return;
    }
    try {
      socketWriter.send({ kind: "mcp-request", clientId, message });
    } catch {
      finish("INVALID_FRAME", true);
    }
  });
  fromClient.on("error", () => finish("INVALID_FRAME", true));
  input.on("data", (data) => fromClient.push(data));
  input.on("end", () => {
    fromClient.finish();
    finish();
  });
  input.on("error", () => finish("STDIN_CLOSED", true));
  output.on("error", () => finish("STDOUT_CLOSED", true));
  return { close: finish, socket };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--descriptor") options.descriptorPath = args[++i];
    if (args[i] === "--pointer") options.pointerPath = args[++i];
    if (args[i] === "--client") options.clientId = args[++i];
  }
  const host = runMcpShim(options);
  process.once("SIGTERM", () => host.close());
  process.once("SIGINT", () => host.close());
}

module.exports = {
  runMcpShim,
  defaultPointerPath,
  resolveDescriptorPath,
  desktopNotRunning,
  localInitialize,
};
