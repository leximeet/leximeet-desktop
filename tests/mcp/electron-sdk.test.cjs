"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");
const { McpGateway } = require("../../electron/services/mcp/gateway.cjs");
const { connect, launchConfig } = require("../../electron/services/mcp/client-config.cjs");

const jar = path.resolve(__dirname, "../../core-java/target/leximeet-core.jar");

function electronBinary() {
  const resolved = require("electron");
  if (typeof resolved !== "string" || !fs.existsSync(resolved))
    throw new Error("需要已安装的 Electron 二进制");
  return resolved;
}

test(
  "真实 Electron 启动脚本 + 官方 MCP SDK 完成 initialize / tools/list / query",
  { timeout: 60000 },
  async (t) => {
    assert.ok(fs.existsSync(jar), "请先 npm run build:core");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-sdk-"));
    const home = path.join(root, "home");
    const bin = path.join(root, "bin");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(bin, { recursive: true });
    const electron = electronBinary();
    const shim = path.resolve(__dirname, "../../electron/mcp-host/main.cjs");
    const projectDir = path.resolve(__dirname, "../..");
    const launch = launchConfig(electron, shim, home, { projectDir });
    const claudeConfig = path.join(home, ".claude.json");
    fs.writeFileSync(
      path.join(bin, "claude"),
      [
        "#!/bin/sh",
        `printf '{"mcpServers":{"leximeet":{"type":"stdio","command":"%s","args":[]}}}\\n' "$9" > "${claudeConfig}"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const cli = connect("claude-code", {
      homeDir: home,
      electronExecutable: electron,
      shimPath: shim,
      env: { PATH: bin },
      preferCli: process.platform !== "win32",
      projectDir,
    });
    if (process.platform !== "win32") assert.equal(cli.method, "cli");
    const written = JSON.parse(fs.readFileSync(claudeConfig, "utf8"));
    assert.equal(written.mcpServers.leximeet.command, launch.command);
    assert.deepEqual(written.mcpServers.leximeet.args, []);
    assert.equal(written.mcpServers.leximeet.env, undefined);
    if (process.platform === "win32") {
      const sidecar = fs.readFileSync(`${launch.command}.launch`, "utf8");
      assert.match(sidecar, /electron=/);
      assert.match(sidecar, /script=/);
    } else {
      const script = fs.readFileSync(launch.command, "utf8");
      assert.match(script, /export ELECTRON_RUN_AS_NODE=1/);
      assert.doesNotMatch(script, /--run-as-node/);
    }
    assert.doesNotMatch(cli.copyCommand, /--run-as-node/);

    const runtime = new JavaRuntime({
      jarPath: jar,
      dataDir: path.join(root, "core"),
      timeout: 20000,
      profile: "test",
    });
    const gateway = new McpGateway({
      core: runtime,
      profile: { root, name: "test" },
      homeDir: home,
      awaitReady: async () => {},
    });
    t.after(async () => {
      await gateway.close();
      await runtime.stop();
      fs.rmSync(root, { recursive: true, force: true });
    });
    await runtime.start();
    await gateway.start();

    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const transport = new StdioClientTransport({
      command: written.mcpServers.leximeet.command,
      args: written.mcpServers.leximeet.args,
      stderr: "pipe",
      env: {
        HOME: home,
        PATH: process.env.PATH,
        LEXIMEET_MCP_DESCRIPTOR: gateway.descriptorPath,
        LEXIMEET_MCP_CLIENT: "cursor",
      },
    });
    const client = new Client({ name: "leximeet-e2e", version: "1.0.1" });
    await client.connect(transport);
    t.after(async () => {
      await client.close().catch(() => {});
    });
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 4);
    assert.equal(listed.tools[0].name, "leximeet_help");
    const help = await client.callTool({ name: "leximeet_help", arguments: {} });
    assert.equal(help.isError, false, JSON.stringify(help));
    const query = await client.callTool({
      name: "leximeet_query",
      arguments: { action: "get_learning_stats", args: {} },
    });
    assert.equal(query.isError, false, JSON.stringify(query));
    const text = query.content?.[0]?.text || JSON.stringify(query.structuredContent || {});
    assert.match(text, /today|learned|stats|quota|count|今日|额度/i);
  },
);
