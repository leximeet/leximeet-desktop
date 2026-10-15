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
  parseTomlHeader,
  paths,
} = require("../../electron/services/mcp/client-config.cjs");

const PROJECT_DIR = path.resolve(__dirname, "../..");

function launchOptions(extra = {}) {
  return { projectDir: PROJECT_DIR, ...extra };
}

function assertManagedLauncher(command) {
  if (process.platform === "win32") {
    const header = fs.readFileSync(command).subarray(0, 2);
    assert.equal(header[0], 0x4d);
    assert.equal(header[1], 0x5a);
    const sidecar = fs.readFileSync(`${command}.launch`, "utf8");
    assert.match(sidecar, /^electron=/m);
    assert.match(sidecar, /^script=/m);
    assert.doesNotMatch(sidecar, /--run-as-node/);
    return;
  }
  const script = fs.readFileSync(command, "utf8");
  assert.match(script, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(script, /exec /);
  assert.doesNotMatch(script, /--run-as-node/);
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-config-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "LexiMeet.app/Contents/MacOS/LexiMeet");
  const shim = path.join(root, "mcp-host/host/main.cjs");
  fs.mkdirSync(path.dirname(electron), { recursive: true });
  fs.mkdirSync(path.dirname(shim), { recursive: true });
  fs.writeFileSync(electron, "#!/bin/sh\n");
  fs.writeFileSync(shim, "shim");
  return { root, electron, shim, launch: launchConfig(electron, shim, root, launchOptions()) };
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
  assertManagedLauncher(f.launch.command);
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
  writeCodex(file, launchConfig(f.electron, f.shim, f.root, launchOptions()));
  writeCodex(file, launchConfig(f.electron, f.shim, f.root, launchOptions()));
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
    ...launchOptions(),
  });
  assert.equal(inspected.status, "connected");
  assert.equal(inspected.broken, false);
  removeCodex(file);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /keep-me|\/missing\/other/);
  assert.doesNotMatch(after, /mcp_servers\.leximeet/);
});

test("Codex TOML 表头识别注释、空白、引号键名与数组表", () => {
  assert.deepEqual(parseTomlHeader("[mcp_servers.leximeet] # installed"), {
    array: false,
    keys: ["mcp_servers", "leximeet"],
  });
  assert.deepEqual(parseTomlHeader("  [ mcp_servers . leximeet ]  "), {
    array: false,
    keys: ["mcp_servers", "leximeet"],
  });
  assert.deepEqual(parseTomlHeader(`[mcp_servers."leximeet"]`), {
    array: false,
    keys: ["mcp_servers", "leximeet"],
  });
  assert.deepEqual(parseTomlHeader(`["mcp_servers"."leximeet"]`), {
    array: false,
    keys: ["mcp_servers", "leximeet"],
  });
  assert.deepEqual(parseTomlHeader("[[projects]] # keep"), {
    array: true,
    keys: ["projects"],
  });
  assert.deepEqual(parseTomlHeader(`["keep]me"]`), {
    array: false,
    keys: ["keep]me"],
  });
  assert.equal(parseTomlHeader("command = 1"), null);
});

test("Codex 断开保留带注释、引号键名与数组表的用户配置", (t) => {
  const f = fixture(t);
  const file = path.join(f.root, ".codex/config.toml");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    [
      "# 用户注释必须保留",
      'model = "gpt-5"',
      "",
      "[mcp_servers.leximeet] # installed by leximeet",
      `command = "${f.launch.command}"`,
      "",
      "  [ projects.foo ] # user settings",
      'path = "/keep/commented"',
      "",
      '["quoted.key"]',
      "value = 1",
      "",
      "['literal.key']",
      "value = 2",
      "",
      `["keep]bracket"]`,
      "value = 3",
      "",
      "[[projects]]",
      'path = "/keep/array"',
      "",
      `[mcp_servers."other"]`,
      'command = "/keep/other"',
      "",
    ].join("\n"),
  );
  removeCodex(file);
  const after = fs.readFileSync(file, "utf8");
  assert.match(after, /# 用户注释必须保留/);
  assert.match(after, /\[ projects\.foo \] # user settings/);
  assert.match(after, /\/keep\/commented/);
  assert.match(after, /\["quoted\.key"\]/);
  assert.match(after, /\['literal\.key'\]/);
  assert.match(after, /\["keep\]bracket"\]/);
  assert.match(after, /\[\[projects\]\]/);
  assert.match(after, /\/keep\/array/);
  assert.match(after, /\[mcp_servers\."other"\]/);
  assert.match(after, /\/keep\/other/);
  assert.doesNotMatch(after, /mcp_servers\.leximeet/);
  assert.equal(leximeetTomlText(after), "");
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
  writeClaude(file, launchConfig(f.electron, f.shim, f.root, launchOptions()));
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
    ...launchOptions(),
  });
  assert.equal(missing.status, "missing");
  fs.mkdirSync(path.join(f.root, ".cursor"), { recursive: true });
  const available = inspectClient("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
    ...launchOptions(),
  });
  assert.equal(available.status, "available");
  connect("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
    preferCli: false,
    ...launchOptions(),
  });
  const connected = inspectClient("cursor", {
    homeDir: f.root,
    electronExecutable: f.electron,
    shimPath: f.shim,
    env: { PATH: "/no-such-bin" },
    ...launchOptions(),
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
    preferCli: process.platform !== "win32",
    ...launchOptions(),
  });
  if (process.platform !== "win32") assert.equal(result.method, "cli");
  const text = fs.readFileSync(config, "utf8");
  assert.match(text, /default_tools_approval_mode = "writes"/);
  assert.match(text, new RegExp(f.launch.command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(text, /--run-as-node/);
  assert.match(result.copyCommand, /codex mcp add leximeet -- /);
  assert.doesNotMatch(result.copyCommand, /--run-as-node/);
});

test("只写官方 ~/.codex/config.toml，不认 CODEX_HOME", (t) => {
  const f = fixture(t);
  process.env.CODEX_HOME = path.join(f.root, "custom-codex");
  t.after(() => {
    delete process.env.CODEX_HOME;
  });
  assert.equal(paths(f.root).codex, path.join(f.root, ".codex", "config.toml"));
});

test("Windows 一键接入写入 .exe 启动器而非 .cmd", (t) => {
  const f = fixture(t);
  const stub = path.join(f.root, "stub.exe");
  fs.writeFileSync(stub, "MZ");
  const launch = launchConfig(f.electron, f.shim, f.root, { platform: "win32", stubPath: stub });
  assert.equal(path.extname(launch.command), ".exe");
  assert.equal(fs.existsSync(`${launch.command}.cmd`), false);
  assert.match(fs.readFileSync(`${launch.command}.launch`, "utf8"), /electron=/);
});
