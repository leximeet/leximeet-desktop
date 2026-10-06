"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { FrameDecoder, FrameWriter } = require("../services/lmcp/framing.cjs");
const { readPrivateJson, assertPrivate } = require("../services/lmcp/private-files.cjs");

/**
 * Chrome 创建的独立进程，仅桥接 stdio 与受保护 UDS，不加载 Electron UI/Core。
 * caller 来源取自 Chrome 的真实 argv；消息中的 extensionOrigin 没有授权意义。
 */
function runNativeHost({
  descriptorPath,
  extensionOrigin,
  input = process.stdin,
  output = process.stdout,
  diagnostic = process.stderr,
  connectTimeoutMs = 5000,
} = {}) {
  let socket;
  let stopped = false;
  let socketWriter;
  let outputWriter;
  let timer;
  const finish = (code = "", failed = false) => {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    input.pause();
    input.destroy();
    socketWriter?.close();
    outputWriter?.close();
    socket?.destroy();
    if (code) diagnostic.write(`LMCP_NATIVE_${code}\n`);
    if (failed) process.exitCode = 1;
  };
  try {
    if (
      !path.isAbsolute(descriptorPath || "") ||
      !/^chrome-extension:\/\/[a-p]{32}\/$/.test(extensionOrigin || "")
    )
      throw new Error("SOURCE_REJECTED");
    const descriptor = readPrivateJson(descriptorPath);
    if (
      descriptor.format !== "leximeet.lmcp-uds/1" ||
      !descriptor.allowedOrigins?.includes(extensionOrigin) ||
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
    input.pause();
    socket = net.connect(descriptor.socketPath);
    socketWriter = new FrameWriter(socket, { onError: () => finish("BACKPRESSURE_LIMIT", true) });
    outputWriter = new FrameWriter(output, { onError: () => finish("BACKPRESSURE_LIMIT", true) });
    const fromBrowser = new FrameDecoder();
    const fromDesktop = new FrameDecoder();
    let ready = false;
    timer = setTimeout(() => finish("CONNECT_TIMEOUT", true), connectTimeoutMs);
    timer.unref();
    socket.on("connect", () =>
      socketWriter.send({ kind: "transport-auth", token: descriptor.token, extensionOrigin }),
    );
    fromDesktop.on("message", (message) => {
      if (!ready) {
        if (message?.kind !== "transport-ready" || message.instanceId !== descriptor.instanceId)
          return finish("SOURCE_REJECTED", true);
        ready = true;
        clearTimeout(timer);
        input.resume();
        return;
      }
      try {
        outputWriter.send(message);
      } catch {
        finish("INVALID_FRAME", true);
      }
    });
    fromBrowser.on("message", (message) => {
      try {
        socketWriter.send(message);
      } catch {
        finish("INVALID_FRAME", true);
      }
    });
    fromBrowser.on("error", () => finish("INVALID_FRAME", true));
    fromDesktop.on("error", () => finish("INVALID_FRAME", true));
    input.on("data", (data) => fromBrowser.push(data));
    input.on("end", () => {
      fromBrowser.finish();
      finish();
    });
    input.on("error", () => finish("STDIN_CLOSED", true));
    output.on("error", () => finish("STDOUT_CLOSED", true));
    socket.on("data", (data) => fromDesktop.push(data));
    socket.on("end", () => {
      fromDesktop.finish();
      finish();
    });
    socket.on("error", () => finish("HOST_UNAVAILABLE", true));
    socket.on("close", () => finish());
    return { close: finish, socket };
  } catch (error) {
    finish(
      ["SOURCE_REJECTED", "UNSAFE_SOCKET"].includes(error.message)
        ? error.message
        : "HOST_UNAVAILABLE",
      true,
    );
    return { close: finish, socket: null };
  }
}

if (require.main === module) {
  // 安装器固定脚本和 descriptor，后面的第一个参数才是 Chrome 的 caller origin。
  const host = runNativeHost({ descriptorPath: process.argv[2], extensionOrigin: process.argv[3] });
  process.once("SIGTERM", () => host.close());
  process.once("SIGINT", () => host.close());
}
module.exports = { runNativeHost };
