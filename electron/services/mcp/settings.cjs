"use strict";
const { spawn } = require("node:child_process");
const {
  CLIENTS,
  inspectClient,
  connect,
  disconnect,
  launchConfig,
} = require("./client-config.cjs");
const { encodeStdio, StdioDecoder } = require("./stdio-framing.cjs");

const ACTIONS = new Set(["state", "connect", "disconnect", "test", "setWriteEnabled"]);

class AssistantSettings {
  constructor({
    core,
    gateway,
    profile,
    electronExecutable,
    shimPath,
    homeDir,
    openExternal = async () => {},
    env = process.env,
    stubPath,
    resourcesPath,
    projectDir,
  }) {
    Object.assign(this, {
      core,
      gateway,
      profile,
      electronExecutable,
      shimPath,
      homeDir,
      openExternal,
      env,
      stubPath,
      resourcesPath,
      projectDir,
    });
  }

  async action(input = { action: "state" }) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("AI 助手连接参数无效");
    if (!ACTIONS.has(input.action)) throw new Error("不支持的 AI 助手连接操作");
    if (input.action === "setWriteEnabled") {
      if (Object.keys(input).some((key) => !["action", "enabled"].includes(key)))
        throw new Error("不支持的 AI 助手连接操作");
      if (typeof input.enabled !== "boolean") throw new Error("写入授权必须是开关");
      await this.core.request("/api/mcp/manage", "POST", {
        action: "setWriteEnabled",
        enabled: input.enabled,
      });
      return this.state();
    }
    if (input.action === "state") {
      if (Object.keys(input).some((key) => key !== "action"))
        throw new Error("不支持的 AI 助手连接操作");
      return this.state();
    }
    if (input.action === "test") {
      if (Object.keys(input).some((key) => key !== "action"))
        throw new Error("不支持的 AI 助手连接操作");
      return { ...(await this.state()), test: await this.testConnection() };
    }
    if (!CLIENTS.includes(input.clientId)) throw new Error("只支持 Cursor、Codex 与 Claude Code");
    if (input.action === "connect") {
      connect(input.clientId, this.options());
      return this.state();
    }
    disconnect(input.clientId, this.options());
    return this.state();
  }

  options() {
    return {
      homeDir: this.homeDir,
      electronExecutable: this.electronExecutable,
      shimPath: this.shimPath,
      env: this.env,
      openExternal: this.openExternal,
      preferDeeplink: false,
      preferCli: false,
      stubPath: this.stubPath,
      resourcesPath: this.resourcesPath,
      projectDir: this.projectDir,
    };
  }

  async state() {
    const manage = await this.core.request("/api/mcp/manage", "POST", { action: "state" });
    return {
      writeEnabled: Boolean(manage.writeEnabled),
      transport: this.gateway.status(),
      clients: CLIENTS.map((id) => inspectClient(id, this.options())),
    };
  }

  testConnection() {
    return new Promise((resolve) => {
      const launch = launchConfig(
        this.electronExecutable,
        this.shimPath,
        this.homeDir,
        this.options(),
      );
      const child = spawn(
        launch.command,
        [...(launch.args || []), "--descriptor", this.gateway.descriptorPath, "--client", "cursor"],
        {
          env: { ...this.env },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const decoder = new StdioDecoder();
      const replies = [];
      const finish = (result) => {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(result);
      };
      const timer = setTimeout(
        () => finish({ ok: false, error: "测试连接超时，请确认词遇正在运行。" }),
        8000,
      );
      decoder.on("message", (message) => {
        replies.push(message);
        if (replies.length === 1)
          child.stdin.write(
            encodeStdio({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
          );
        if (replies.length >= 2) {
          const tools = replies[1]?.result?.tools || [];
          finish({
            ok: Boolean(replies[0]?.result?.serverInfo && tools.length === 4),
            server: replies[0]?.result?.serverInfo || null,
            tools: tools.map((tool) => tool.name),
            error: replies[0]?.error?.data?.code || replies[1]?.error?.data?.code || "",
          });
        }
      });
      decoder.on("error", () => finish({ ok: false, error: "测试连接收到畸形帧" }));
      child.stdout.on("data", (data) => decoder.push(data));
      child.on("error", (error) => finish({ ok: false, error: error.message }));
      child.stdin.write(
        encodeStdio({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "leximeet-settings", version: "1.0.1" },
          },
        }),
      );
    });
  }
}

module.exports = { AssistantSettings };
