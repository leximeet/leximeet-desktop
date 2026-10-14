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
  return { root, electron, shim, launch: launchConfig(electron, shim, "cursor") };
}

test("Cursor 写入只改 leximeet 键，保留其他 server，幂等且先备份", (t) => {
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
  assert.equal(data.mcpServers.leximeet.command, f.electron);
  assert.equal(data.mcpServers.leximeet.args[1], f.shim);
  assert.doesNotMatch(JSON.stringify(data), /token|secret/i);
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

test("Codex TOML 保留注释与其他表，只替换 leximeet", (t) => {
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
      'command = "keep-me"',
      "",
    ].join("\n"),
  );
  writeCodex(file, launchConfig(f.electron, f.shim, "codex"));
  writeCodex(file, launchConfig(f.electron, f.shim, "codex"));
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /# 用户注释必须保留/);
  assert.match(text, /command = "keep-me"/);
  assert.match(text, /\[mcp_servers\.leximeet\]/);
  assert.match(text, /default_tools_approval_mode = "writes"/);
  assert.doesNotMatch(text, /token|secret/i);
  removeCodex(file);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /keep-me/);
  assert.doesNotMatch(after, /mcp_servers\.leximeet/);
});

test("Claude Code 写入 user 级 mcpServers 且可干净断开", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".claude.json");
  writeClaude(file, launchConfig(f.electron, f.shim, "claude-code"));
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(data.mcpServers.leximeet.type, "stdio");
  assert.equal(data.mcpServers.leximeet.args.includes("--client"), true);
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
});
