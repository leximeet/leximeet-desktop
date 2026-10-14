"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  writeCursor,
  writeCodex,
  writeClaude,
  removeCursor,
  removeCodex,
  removeClaude,
  inspectClient,
  connect,
  launchConfig,
  launcherPath,
  cursorDeeplink,
  leximeetTomlText,
} = require("../../electron/services/mcp/client-config.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "LexiMeet.app/Contents/MacOS/LexiMeet");
  const shim = path.join(root, "mcp-host/host/main.cjs");
  fs.mkdirSync(path.dirname(electron), { recursive: true });
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(electron, "#!/bin/sh\n");
  fs.writeFileSync(shim, "shim");
  return { root, electron, shim, launch: launchConfig(electron, shim, root) };
}

test("Cursor 写入只改 leximeet 键，只配启动脚本，幂等且先备份", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `${JSON.stringify({ mcpServers: { other: { command: "keep" } } }, null, 2)}\n`,
  );
  const first = writeCursor(file, f.launch);
  assert.equal(first.changed, true);
  const second = writeCursor(file, f.launch);
  assert.equal(second.changed, false);
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.mcpServers.other.command, "keep");
  assert.equal(data.mcpServers.leximeet.command, f.launch.command);
  assert.deepEqual(data.mcpServers.leximeet.args, []);
  assert.equal(data.mcpServers.leximeet.env, undefined);
  assert.doesNotMatch(JSON.stringify(data), /token|secret|--run-as-node/i);
  const script = fs.readFileSync(f.launch.command, "utf8");
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(script, /exec /);
  const backups = fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.includes(".leximeet.bak."));
  assert.equal(backups.length, 1);
  removeCursor(file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.other.command, "keep");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.leximeet, undefined);
});

test("损坏的 JSON 拒绝写入", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".cursor/mcp.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  assert.throws(() => writeCursor(file, f.launch), /无法解析/);
  assert.equal(fs.readFileSync(file, "utf8"), "{ not json");
});

test("Codex TOML 只在 leximeet 表内判断状态与幂等", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".codex/config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "# 用户注释必须保留",
      'model = "gpt-5"',
      "",
      "[mcp_servers.other]",
      'command = "/missing/other"',
      "",
    ].join("\n"),
  );
  writeCodex(file, launchConfig(f.electron, f.shim, f.root));
  writeCodex(file, launchConfig(f.electron, f.shim, f.root));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /# 用户注释必须保留/);
  assert.match(text, /command = "\/missing\/other"/);
  assert.match(text, /\[mcp_servers\.leximeet\]/);
  assert.match(text, /default_tools_approval_mode = "writes"/);
  assert.doesNotMatch(text, /token|secret|--run-as-node/i);
  const body = leximeetTomlText(text);
  assert.match(body, new RegExp(f.launch.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const inspected = inspectClient("codex", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
  });
  assert.equal(inspected.status, "connected");
  assert.equal(inspected.broken, false);
  removeCodex(file);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /keep-me|\/missing\/other/);
  assert.doesNotMatch(after, /mcp_servers\.leximeet/);
});

test("Codex 断开不删除后续数组表", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".codex/config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "[mcp_servers.leximeet]",
      `command = "${f.launch.command}"`,
      "",
      "[[projects]]",
      'path = "/keep/me"',
      "",
    ].join("\n"),
  );
  removeCodex(file);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /\[\[projects\]\]/);
  assert.match(after, /\/keep\/me/);
  assert.doesNotMatch(after, /mcp_servers\.leximeet/);
});

test("Claude Code 写入 user 级 mcpServers 且可干净断开", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".claude.json");
  writeClaude(file, launchConfig(f.electron, f.shim, f.root));
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.mcpServers.leximeet.type, "stdio");
  assert.equal(data.mcpServers.leximeet.command, launcherPath(f.root));
  assert.deepEqual(data.mcpServers.leximeet.args, []);
  removeClaude(file);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mcpServers.leximeet, undefined);
});

test("检测状态覆盖未安装、可接入与已接入", (t) => {
  const f = fixture(t);
  const missing = inspectClient("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
  });
  assert.equal(missing.status, "missing");
  fs.mkdirSync(path.join(f.root, ".cursor"), { recursive: true });
  const available = inspectClient("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
  });
  assert.equal(available.status, "available");
  connect("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
    preferCli: false,
  });
  const connected = inspectClient("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
  });
  assert.equal(connected.status, "connected");
  assert.match(
    connected.copyCommand,
    /^cursor:\/\/anysphere\.cursor-deeplink\/mcp\/install\?name=/,
  );
  assert.match(connected.copyCommand, /config=/);
});

test("Cursor deeplink 对 name 与 config 做 encodeURIComponent", (t) => {
  const f = fixture(t);
  const link = cursorDeeplink(f.launch);
  const url = new URL(link);
  assert.equal(url.protocol, "cursor:");
  assert.equal(decodeURIComponent(url.searchParams.get("name")), "leximeet");
  const decoded = JSON.parse(
    Buffer.from(decodeURIComponent(url.searchParams.get("config")), "base64").toString("utf8"),
  );
  assert.equal(decoded.command, f.launch.command);
  assert.deepEqual(decoded.args, []);
});

test("备份只保留最近 3 份", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".cursor/mcp.json");
  writeCursor(file, f.launch);
  for (let i = 0; i < 4; i++) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    data.mcpServers.other = { command: `keep-${i}` };
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    writeCursor(file, { command: `${f.launch.command}-v${i}`, args: [] });
  }
  const backups = fs
    .readdirSync(path.dirname(file))
    .filter((name) => name.includes(".leximeet.bak."));
  assert.equal(backups.length, 3);
});

test("Codex CLI 接入后补写 writes 批准且只配启动脚本", (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const config = path.join(f.root, ".codex/config.toml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(
    path.join(bin, "codex"),
    [
      "#!/bin/sh",
      `printf '[mcp_servers.leximeet]\\ncommand = "%s"\\n' "$5" > "${config}"`,
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const result = connect("codex", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: bin },
    preferCli: true,
  });
  assert.equal(result.method, "cli");
  const text = fs.readFileSync(config, "utf8");
  assert.match(text, /default_tools_approval_mode = "writes"/);
  assert.match(text, new RegExp(f.launch.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /--run-as-node/);
  assert.match(result.copyCommand, /codex mcp add leximeet -- /);
  assert.doesNotMatch(result.copyCommand, /--run-as-node/);
});
