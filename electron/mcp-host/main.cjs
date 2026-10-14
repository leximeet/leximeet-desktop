"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const os = require("node:os");
const { FrameDecoder, FrameWriter } = require("../services/lmcp/framing.cjs");
const { readPrivateJson, assertPrivate } = require("../services/lmcp/private-files.cjs");
const { encodeStdio, StdioDecoder } = require("../services/mcp/stdio-framing.cjs");

/**
 * 薄 stdio 转发：AI 客户端只配置本脚本的绝对路径，不放 Core 令牌或端口。
 * 桌面未运行时对带 id 的 JSON-RPC 返回 DESKTOP_NOT_RUNNING，不自动拉起应用。
 */
function defaultPointerPath(homeDir = os.homedir()) {
  if (process.platform === "darwin")
    return path.join(homeDir, "Library/Application Support/LexiMeet/mcp/current.json");
  return path.join(homeDir, ".config/LexiMeet/mcp/current.json");
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
  let stopped = false;
  let socketWriter;
  let ready = false;
  let timer;
  const pending = [];
  const finish = (code = "", failed = false) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    input.pause();
    input.destroy();
    socketWriter?.close();
    socket?.destroy();
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
  const rejectPending = () => {
    while (pending.length) {
      const message = pending.shift();
      if (message && Object.hasOwn(message, "id") && message.id !== null)
        write(desktopNotRunning(message.id));
    }
  };
  const flushPending = () => {
    while (pending.length && socketWriter) {
      socketWriter.send({ kind: "mcp-request", clientId, message: pending.shift() });
    }
  };
  const fromClient = new StdioDecoder();
  fromClient.on("message", (message) => {
    if (stopped) return;
    const hasId = message && Object.hasOwn(message, "id") && message.id !== null;
    if (!ready) {
      pending.push(message);
      return;
    }
    if (!socketWriter) {
      if (hasId) write(desktopNotRunning(message.id));
      return;
    }
    try {
      socketWriter.send({
        kind: "mcp-request",
        clientId,
        message,
      });
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

  try {
    const resolved = resolveDescriptorPath({ descriptorPath, pointerPath, homeDir });
    if (!resolved) {
      ready = true;
      rejectPending();
      return { close: finish, socket: null };
    }
    if (!path.isAbsolute(resolved)) throw new Error("SOURCE_REJECTED");
    const descriptor = readPrivateJson(resolved);
    if (
      descriptor.format !== "leximeet.mcp-uds/1" ||
      !/^[a-f0-9]{64}$/.test(descriptor.token || "") ||
      !path.isAbsolute(descriptor.socketPath || "")
    )
      throw new Error("SOURCE_REJECTED");
    assertPrivate(path.dirname(descriptor.socketPath), { directory: true });
    const stat = fs.lstatSync(descriptor.socketPath);
    if (
      !stat.isSocket() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o077 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("UNSAFE_SOCKET");
    socket = net.connect(descriptor.socketPath);
    socketWriter = new FrameWriter(socket, { onError: () => finish("BACKPRESSURE_LIMIT", true) });
    const fromDesktop = new FrameDecoder();
    timer = setTimeout(() => {
      rejectPending();
      write(desktopNotRunning(null));
      finish("CONNECT_TIMEOUT", true);
    }, connectTimeoutMs);
    timer.unref();
    socket.on("connect", () =>
      socketWriter.send({ kind: "transport-auth", token: descriptor.token, clientId }),
    );
    fromDesktop.on("message", (message) => {
      if (!ready) {
        if (message?.kind !== "transport-ready" || message.instanceId !== descriptor.instanceId)
          return finish("SOURCE_REJECTED", true);
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
      rejectPending();
      finish();
    });
    socket.on("error", () => {
      rejectPending();
      finish("HOST_UNAVAILABLE", true);
    });
    socket.on("close", () => finish());
    return { close: finish, socket };
  } catch (error) {
    const code = ["SOURCE_REJECTED", "UNSAFE_SOCKET"].includes(error.message)
      ? error.message
      : "HOST_UNAVAILABLE";
    ready = true;
    rejectPending();
    diagnostic.write(`LEXIMEET_MCP_${code}\n`);
    return { close: finish, socket: null };
  }
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

module.exports = { runMcpShim, defaultPointerPath, resolveDescriptorPath, desktopNotRunning };
