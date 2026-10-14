"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");

const SERVER_NAME = "leximeet";
const CLIENTS = Object.freeze(["cursor", "codex", "claude-code"]);
const quote = (text) => `'${String(text).replaceAll("'", `'\\''`)}'`;

function homeOf(homeDir = os.homedir()) {
  if (!path.isAbsolute(homeDir || "")) throw new Error("HOME_MUST_BE_ABSOLUTE");
  return homeDir;
}

function paths(homeDir) {
  const home = homeOf(homeDir);
  return {
    cursor: path.join(home, ".cursor", "mcp.json"),
    codex: path.join(home, ".codex", "config.toml"),
    "claude-code": path.join(home, ".claude.json"),
  };
}

function launcherPath(homeDir = os.homedir()) {
  const home = homeOf(homeDir);
  if (process.platform === "darwin")
    return path.join(home, "Library/Application Support/LexiMeet/mcp/leximeet-mcp");
  return path.join(home, ".config/LexiMeet/mcp/leximeet-mcp");
}

function commandOnPath(name, env = process.env) {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return "";
}

// 仿 Native Host：客户端只执行本脚本，由脚本导出 ELECTRON_RUN_AS_NODE 再 exec Electron。
function ensureLauncher({ homeDir, electronExecutable, shimPath }) {
  if (!path.isAbsolute(electronExecutable || "") || !path.isAbsolute(shimPath || ""))
    throw new Error("MCP_LAUNCH_PATHS_MUST_BE_ABSOLUTE");
  const file = launcherPath(homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = [
    "#!/bin/sh",
    "# 词遇管理的 MCP 转发：随包 Electron 的 Node 模式，无需系统 Node/JDK。",
    "unset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR ELECTRON_ENABLE_LOGGING ELECTRON_LOG_FILE",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${quote(electronExecutable)} ${quote(shimPath)} "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(file, text, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function launchConfig(electronExecutable, shimPath, homeDir) {
  return {
    command: ensureLauncher({ homeDir, electronExecutable, shimPath }),
    args: [],
  };
}

function equivalentLaunch(existing, desired) {
  if (!existing || existing.command !== desired.command) return false;
  const args = existing.args || [];
  return Array.isArray(args) && args.length === 0;
}

function containsSecret(value) {
  return /token|secret|password|authorization/i.test(JSON.stringify(value));
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.leximeet.bak.${stamp}.${randomBytes(3).toString("hex")}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  pruneBackups(file);
  return backup;
}

function pruneBackups(file) {
  const directory = path.dirname(file);
  const prefix = `${path.basename(file)}.leximeet.bak.`;
  if (!fs.existsSync(directory)) return;
  const backups = fs
    .readdirSync(directory)
    .filter((name) => name.startsWith(prefix))
    .map((name) => {
      const full = path.join(directory, name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((left, right) => right.mtime - left.mtime);
  for (const extra of backups.slice(3)) fs.rmSync(extra.full, { force: true });
}

function atomicWrite(file, text) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } catch (error) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      /* 残留临时文件不影响主错误 */
    }
    throw error;
  }
}

function mtimeOf(file) {
  return fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
}

function mutateConfig(file, apply) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existed = fs.existsSync(file);
    const before = mtimeOf(file);
    const existing = existed ? readText(file) : "";
    const next = apply(existing);
    if (next == null) return { changed: false, file };
    if (mtimeOf(file) !== before) {
      if (attempt === 2) throw new Error("配置文件正在被其他进程修改，请稍后重试");
      continue;
    }
    if (existed) backupFile(file);
    if (mtimeOf(file) !== before) {
      if (attempt === 2) throw new Error("配置文件正在被其他进程修改，请稍后重试");
      continue;
    }
    atomicWrite(file, next);
    return { changed: true, file };
  }
  return { changed: false, file };
}

function readText(file) {
  if (!fs.existsSync(file)) return "";
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("UNSAFE_CONFIG_PATH");
  return fs.readFileSync(file, "utf8");
}

function parseJsonOrThrow(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} 无法解析，已停止写入以免破坏原文件`);
  }
}

function writeCursor(file, launch) {
  if (containsSecret(launch)) throw new Error("拒绝把密钥写入客户端配置");
  return mutateConfig(file, (existing) => {
    const data = existing ? parseJsonOrThrow(existing, "Cursor mcp.json") : {};
    if (typeof data !== "object" || Array.isArray(data))
      throw new Error("Cursor mcp.json 根必须是对象");
    data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
    const next = { command: launch.command, args: launch.args || [] };
    if (equivalentLaunch(data.mcpServers[SERVER_NAME], next)) return null;
    data.mcpServers[SERVER_NAME] = next;
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

function removeCursor(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  return mutateConfig(file, (existing) => {
    const data = parseJsonOrThrow(existing, "Cursor mcp.json");
    if (!data.mcpServers || !Object.hasOwn(data.mcpServers, SERVER_NAME)) return null;
    delete data.mcpServers[SERVER_NAME];
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

function tomlEscape(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodexTable(launch) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlEscape(launch.command)}`,
    `args = []`,
    `default_tools_approval_mode = "writes"`,
    "",
  ].join("\n");
}

function findTomlTables(source, name) {
  const lines = source.split(/\r?\n/);
  const ranges = [];
  let start = -1;
  // TOML 允许表头行尾注释，如 `[projects.foo] # user settings`。
  const header = new RegExp(`^\\s*\\[mcp_servers\\.${name}(?:\\.[^\\]]+)?\\]\\s*(?:#.*)?$`);
  // 普通表 [a] 与数组表 [[a]] 都是新表起点，避免把后续用户配置算进 leximeet。
  const other = /^\s*\[{1,2}[^\]]+\]{1,2}\s*(?:#.*)?$/;
  for (let i = 0; i <= lines.length; i++) {
    const line = lines[i] || "";
    if (i === lines.length || other.test(line)) {
      if (start >= 0) {
        ranges.push([start, i]);
        start = -1;
      }
      if (i < lines.length && header.test(line)) start = i;
    }
  }
  return { lines, ranges };
}

function leximeetTomlText(source) {
  const { lines, ranges } = findTomlTables(source, SERVER_NAME);
  return ranges.map(([from, to]) => lines.slice(from, to).join("\n")).join("\n");
}

function extractTomlCommand(body) {
  return /(?:^|\n)\s*command\s*=\s*"([^"]+)"/.exec(body)?.[1] || "";
}

function codexTableMatches(body, launch) {
  return (
    Boolean(body) &&
    extractTomlCommand(body) === launch.command &&
    /default_tools_approval_mode\s*=\s*"writes"/.test(body)
  );
}

function replaceTomlTables(existing, table) {
  const { lines, ranges } = findTomlTables(existing, SERVER_NAME);
  const keep = lines.filter(
    (_, index) => !ranges.some(([from, to]) => index >= from && index < to),
  );
  while (keep.length && keep[keep.length - 1] === "") keep.pop();
  return `${keep.join("\n")}${keep.length ? "\n\n" : ""}${table}`;
}

function writeCodex(file, launch) {
  if (containsSecret(launch)) throw new Error("拒绝把密钥写入客户端配置");
  return mutateConfig(file, (existing) => {
    const table = renderCodexTable(launch);
    if (!existing) return table;
    if (codexTableMatches(leximeetTomlText(existing), launch)) return null;
    return replaceTomlTables(existing, table);
  });
}

function removeCodex(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  return mutateConfig(file, (existing) => {
    const { lines, ranges } = findTomlTables(existing, SERVER_NAME);
    if (!ranges.length) return null;
    const keep = lines.filter(
      (_, index) => !ranges.some(([from, to]) => index >= from && index < to),
    );
    while (keep.length && keep[keep.length - 1] === "") keep.pop();
    return keep.length ? `${keep.join("\n")}\n` : "";
  });
}

function writeClaude(file, launch) {
  if (containsSecret(launch)) throw new Error("拒绝把密钥写入客户端配置");
  return mutateConfig(file, (existing) => {
    const data = existing ? parseJsonOrThrow(existing, "Claude Code ~/.claude.json") : {};
    if (typeof data !== "object" || Array.isArray(data)) throw new Error("Claude 配置根必须是对象");
    data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
    const next = { type: "stdio", command: launch.command, args: launch.args || [] };
    if (equivalentLaunch(data.mcpServers[SERVER_NAME], next)) return null;
    data.mcpServers[SERVER_NAME] = next;
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

function removeClaude(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  return mutateConfig(file, (existing) => {
    const data = parseJsonOrThrow(existing, "Claude Code ~/.claude.json");
    if (!data.mcpServers || !Object.hasOwn(data.mcpServers, SERVER_NAME)) return null;
    delete data.mcpServers[SERVER_NAME];
    return `${JSON.stringify(data, null, 2)}\n`;
  });
}

function inspectClient(id, { homeDir, electronExecutable, shimPath, env = process.env }) {
  const file = paths(homeDir)[id];
  const binaries = { cursor: "cursor", codex: "codex", "claude-code": "claude" };
  const installed = fs.existsSync(path.dirname(file)) || Boolean(commandOnPath(binaries[id], env));
  let connected = false;
  let broken = false;
  let launch = null;
  if (fs.existsSync(file)) {
    try {
      if (id === "codex") {
        const body = leximeetTomlText(readText(file));
        const command = extractTomlCommand(body);
        connected = Boolean(body && /\[mcp_servers\.leximeet\]/.test(body));
        broken = Boolean(command && !fs.existsSync(command));
        if (connected) launch = { command, args: [] };
      } else {
        const data = parseJsonOrThrow(readText(file), id);
        launch = data.mcpServers?.[SERVER_NAME] || null;
        connected = Boolean(launch);
        broken = Boolean(launch?.command && !fs.existsSync(launch.command));
      }
    } catch {
      broken = true;
    }
  }
  let status = "missing";
  if (broken) status = "broken";
  else if (connected) status = "connected";
  else if (installed) status = "available";
  const desired =
    electronExecutable && shimPath ? launchConfig(electronExecutable, shimPath, homeDir) : null;
  return {
    id,
    status,
    installed,
    connected,
    broken,
    file,
    deeplink: id === "cursor" && desired ? cursorDeeplink(desired) : "",
    copyCommand: desired ? copyCommand(id, desired) : "",
  };
}

function cursorDeeplink(launch) {
  const config = Buffer.from(
    JSON.stringify({ command: launch.command, args: launch.args || [] }),
    "utf8",
  ).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(config)}`;
}

function copyCommand(id, launch) {
  if (!launch?.command) return "";
  if (id === "codex") return `codex mcp add ${SERVER_NAME} -- ${quote(launch.command)}`;
  if (id === "claude-code")
    return `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${quote(launch.command)}`;
  return cursorDeeplink(launch);
}

function connectWithCli(cli, args, env) {
  return spawnSync(cli, args, { encoding: "utf8", env: env || process.env });
}

function connect(id, options) {
  if (!CLIENTS.includes(id)) throw new Error("不支持的客户端");
  const launch = launchConfig(options.electronExecutable, options.shimPath, options.homeDir);
  const file = paths(options.homeDir)[id];
  if (id === "cursor") {
    if (options.preferDeeplink && options.openExternal) {
      options.openExternal(cursorDeeplink(launch));
      return { method: "deeplink", ...inspectClient(id, options) };
    }
    return { method: "file", ...writeCursor(file, launch), ...inspectClient(id, options) };
  }
  if (id === "codex") {
    const cli = commandOnPath("codex", options.env);
    if (cli && options.preferCli !== false) {
      const result = connectWithCli(
        cli,
        ["mcp", "add", SERVER_NAME, "--", launch.command],
        options.env,
      );
      if (result.status === 0) {
        writeCodex(file, launch);
        return { method: "cli", ...inspectClient(id, options) };
      }
    }
    return { method: "file", ...writeCodex(file, launch), ...inspectClient(id, options) };
  }
  const cli = commandOnPath("claude", options.env);
  if (cli && options.preferCli !== false) {
    const result = connectWithCli(
      cli,
      ["mcp", "add", "--scope", "user", "--transport", "stdio", SERVER_NAME, "--", launch.command],
      options.env,
    );
    if (result.status === 0) {
      writeClaude(file, launch);
      return { method: "cli", ...inspectClient(id, options) };
    }
  }
  return { method: "file", ...writeClaude(file, launch), ...inspectClient(id, options) };
}

function disconnect(id, options) {
  if (!CLIENTS.includes(id)) throw new Error("不支持的客户端");
  const file = paths(options.homeDir)[id];
  if (id === "cursor") return { ...removeCursor(file), ...inspectClient(id, options) };
  if (id === "codex") return { ...removeCodex(file), ...inspectClient(id, options) };
  return { ...removeClaude(file), ...inspectClient(id, options) };
}

module.exports = {
  CLIENTS,
  SERVER_NAME,
  paths,
  launcherPath,
  ensureLauncher,
  launchConfig,
  inspectClient,
  connect,
  disconnect,
  writeCursor,
  writeCodex,
  writeClaude,
  removeCursor,
  removeCodex,
  removeClaude,
  cursorDeeplink,
  commandOnPath,
  findTomlTables,
  leximeetTomlText,
};
