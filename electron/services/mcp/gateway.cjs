"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { FrameDecoder, FrameWriter, MAX_FRAME_BYTES } = require("../lmcp/framing.cjs");
const {
  ensurePrivateDirectory,
  writePrivateJson,
  readPrivateJson,
} = require("../lmcp/private-files.cjs");

function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 复用 LMCP 帧与私有文件：shim 只到同用户 UDS，Core 令牌永不进入客户端配置。
 */
class McpGateway {
  constructor({
    core,
    profile,
    awaitReady = async () => {},
    pointerPath,
    homeDir = os.homedir(),
    handshakeTimeoutMs = 5000,
    forwardTimeoutMs = 20000,
    maxConnections = 8,
  }) {
    if (!core?.request || !path.isAbsolute(profile?.root || ""))
      throw new Error("INVALID_MCP_GATEWAY_OPTIONS");
    Object.assign(this, {
      core,
      profile,
      awaitReady,
      homeDir,
      handshakeTimeoutMs,
      forwardTimeoutMs,
      maxConnections,
    });
    this.pointerPath =
      pointerPath ||
      path.join(
        homeDir,
        process.platform === "darwin"
          ? "Library/Application Support/LexiMeet/mcp/current.json"
          : ".config/LexiMeet/mcp/current.json",
      );
    this.descriptorPath = path.join(profile.root, "mcp", "mcp-uds.json");
    this.server = null;
    this.socketPath = "";
    this.socketDirectory = "";
    this.token = "";
    this.instanceId = "";
    this.connections = new Set();
    this.lastError = null;
  }

  async start() {
    if (this.server) return this;
    this.instanceId = randomUUID();
    const base = `/tmp/leximeet-mcp-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
    ensurePrivateDirectory(base);
    const key = createHash("sha256").update(this.profile.root).digest("hex").slice(0, 20);
    this.socketDirectory = path.join(base, key, this.instanceId.slice(0, 8));
    ensurePrivateDirectory(path.dirname(this.socketDirectory));
    ensurePrivateDirectory(this.socketDirectory);
    this.socketPath = path.join(this.socketDirectory, "mcp.sock");
    this.token = randomBytes(32).toString("hex");
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, resolve);
    });
    fs.chmodSync(this.socketPath, 0o600);
    this.writeDescriptor();
    this.writePointer();
    this.lastError = null;
    return this;
  }

  writeDescriptor() {
    writePrivateJson(this.descriptorPath, {
      format: "leximeet.mcp-uds/1",
      instanceId: this.instanceId,
      socketPath: this.socketPath,
      token: this.token,
      pid: process.pid,
      maxFrameBytes: MAX_FRAME_BYTES,
    });
  }

  writePointer() {
    if (this.profile.name !== "local" && !process.env.LEXIMEET_MCP_WRITE_POINTER) return;
    writePrivateJson(this.pointerPath, {
      format: "leximeet.mcp-pointer/1",
      descriptorPath: this.descriptorPath,
      pid: process.pid,
      writtenAt: new Date().toISOString(),
    });
  }

  accept(socket) {
    if (this.connections.size >= this.maxConnections) {
      socket.destroy();
      return;
    }
    const session = {
      socket,
      writer: new FrameWriter(socket, { onError: () => socket.destroy() }),
      decoder: new FrameDecoder(),
      authed: false,
      timer: setTimeout(() => socket.destroy(), this.handshakeTimeoutMs),
    };
    session.timer.unref();
    this.connections.add(session);
    socket.on("data", (data) => session.decoder.push(data));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(session.timer);
      session.writer.close();
      this.connections.delete(session);
    });
    session.decoder.on("error", () => socket.destroy());
    session.decoder.on("message", (message) => this.onMessage(session, message));
  }

  async onMessage(session, message) {
    try {
      if (!session.authed) {
        if (
          message?.kind !== "transport-auth" ||
          !equalToken(message.token, this.token) ||
          !/^[A-Za-z0-9_-]{1,40}$/.test(message.clientId || "unknown")
        )
          throw new Error("SOURCE_REJECTED");
        clearTimeout(session.timer);
        session.authed = true;
        session.clientId = message.clientId || "unknown";
        session.writer.send({ kind: "transport-ready", instanceId: this.instanceId });
        return;
      }
      if (
        message?.kind !== "mcp-request" ||
        !message.message ||
        typeof message.message !== "object"
      )
        throw new Error("INVALID_FRAME");
      let payload;
      try {
        await this.awaitReady();
        payload = await this.core.request("/api/mcp", "POST", {
          clientId: message.clientId || session.clientId,
          message: message.message,
        });
      } catch (error) {
        const id =
          message.message && Object.hasOwn(message.message, "id") ? message.message.id : null;
        payload = {
          message: {
            jsonrpc: "2.0",
            id,
            error: {
              code: -32000,
              message: "DESKTOP_NOT_RUNNING: 词遇桌面未运行，请先打开应用后再试。",
              data: { code: "DESKTOP_NOT_RUNNING" },
            },
          },
        };
        this.lastError = error.message;
      }
      session.writer.send({ kind: "mcp-response", message: payload?.message || payload });
    } catch {
      session.socket.destroy();
    }
  }

  status() {
    return {
      running: Boolean(this.server),
      connections: this.connections.size,
      descriptorPath: this.descriptorPath,
      lastError: this.lastError,
    };
  }

  async close() {
    for (const session of [...this.connections]) session.socket.destroy();
    this.connections.clear();
    await new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
    if (this.socketPath && fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath);
    if (this.socketDirectory) {
      try {
        fs.rmdirSync(this.socketDirectory);
      } catch {
        /* 目录非空则保留 */
      }
    }
    if (fs.existsSync(this.descriptorPath)) fs.rmSync(this.descriptorPath, { force: true });
    if (fs.existsSync(this.pointerPath)) {
      try {
        const current = readPrivateJson(this.pointerPath);
        if (current.descriptorPath === this.descriptorPath)
          fs.rmSync(this.pointerPath, { force: true });
      } catch {
        /* 指针不属于本次实例则保留 */
      }
    }
  }
}

module.exports = { McpGateway };
