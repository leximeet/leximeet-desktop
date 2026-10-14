"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

const SERVER_NAME = "leximeet";
const CLIENTS = Object.freeze(["cursor", "codex", "claude-code"]);

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

function commandOnPath(name, env = process.env) {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return "";
}

function launchConfig(electronExecutable, shimPath, clientId) {
  if (!path.isAbsolute(electronExecutable || "") || !path.isAbsolute(shimPath || ""))
    throw new Error("MCP_LAUNCH_PATHS_MUST_BE_ABSOLUTE");
  return {
    command: electronExecutable,
    args: ["--run-as-node", shimPath, "--client", clientId],
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

function equivalentLaunch(existing, desired) {
  return (
    existing &&
    existing.command === desired.command &&
    JSON.stringify(existing.args || []) === JSON.stringify(desired.args) &&
    (!existing.env || existing.env.ELECTRON_RUN_AS_NODE === "1")
  );
}

function containsSecret(value) {
  return /token|secret|password|authorization/i.test(JSON.stringify(value));
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${file}.leximeet.bak.${stamp}`;
  fs.copyFileSync(file, backup);
  fs.chmodSync(backup, 0o600);
  return backup;
}

function atomicWrite(file, text) {
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, file);
  fs.chmodSync(file, 0o600);
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
  const existing = readText(file);
  const data = existing ? parseJsonOrThrow(existing, "Cursor mcp.json") : {};
  if (typeof data !== "object" || Array.isArray(data))
    throw new Error("Cursor mcp.json 根必须是对象");
  data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
  const next = {
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
  if (equivalentLaunch(data.mcpServers[SERVER_NAME], next)) return { changed: false, file };
  if (containsSecret(next)) throw new Error("拒绝把密钥写入客户端配置");
  if (existing) backupFile(file);
  data.mcpServers[SERVER_NAME] = next;
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true, file };
}

function removeCursor(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  const data = parseJsonOrThrow(readText(file), "Cursor mcp.json");
  if (!data.mcpServers || !Object.hasOwn(data.mcpServers, SERVER_NAME))
    return { changed: false, file };
  backupFile(file);
  delete data.mcpServers[SERVER_NAME];
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true, file };
}

function tomlEscape(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function renderCodexTable(launch) {
  return [
    `[mcp_servers.${SERVER_NAME}]`,
    `command = ${tomlEscape(launch.command)}`,
    `args = [${launch.args.map(tomlEscape).join(", ")}]`,
    `default_tools_approval_mode = "writes"`,
    "",
    `[mcp_servers.${SERVER_NAME}.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    "",
  ].join("\n");
}

function findTomlTables(source, name) {
  const lines = source.split(/\r?\n/);
  const ranges = [];
  let start = -1;
  const header = new RegExp(`^\\[mcp_servers\\.${name}(?:\\.[^\\]]+)?\\]\\s*$`);
  const other = /^\[[^\]]+\]\s*$/;
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

function writeCodex(file, launch) {
  const existing = readText(file);
  const table = renderCodexTable(launch);
  if (existing) {
    const { lines, ranges } = findTomlTables(existing, SERVER_NAME);
    const current = ranges.map(([from, to]) => lines.slice(from, to).join("\n").trim()).join("\n");
    if (current.includes(launch.command) && current.includes(launch.args[1]))
      return { changed: false, file };
    backupFile(file);
    const keep = lines.filter(
      (_, index) => !ranges.some(([from, to]) => index >= from && index < to),
    );
    while (keep.length && keep[keep.length - 1] === "") keep.pop();
    atomicWrite(file, `${keep.join("\n")}${keep.length ? "\n\n" : ""}${table}`);
    return { changed: true, file };
  }
  atomicWrite(file, table);
  return { changed: true, file };
}

function removeCodex(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  const existing = readText(file);
  const { lines, ranges } = findTomlTables(existing, SERVER_NAME);
  if (!ranges.length) return { changed: false, file };
  backupFile(file);
  const keep = lines.filter(
    (_, index) => !ranges.some(([from, to]) => index >= from && index < to),
  );
  while (keep.length && keep[keep.length - 1] === "") keep.pop();
  atomicWrite(file, keep.length ? `${keep.join("\n")}\n` : "");
  return { changed: true, file };
}

function writeClaude(file, launch) {
  const existing = readText(file);
  const data = existing ? parseJsonOrThrow(existing, "Claude Code ~/.claude.json") : {};
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("Claude 配置根必须是对象");
  data.mcpServers = data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers : {};
  const next = {
    type: "stdio",
    command: launch.command,
    args: launch.args,
    env: launch.env,
  };
  if (
    data.mcpServers[SERVER_NAME]?.command === next.command &&
    JSON.stringify(data.mcpServers[SERVER_NAME]?.args || []) === JSON.stringify(next.args)
  )
    return { changed: false, file };
  if (existing) backupFile(file);
  data.mcpServers[SERVER_NAME] = next;
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true, file };
}

function removeClaude(file) {
  if (!fs.existsSync(file)) return { changed: false, file };
  const data = parseJsonOrThrow(readText(file), "Claude Code ~/.claude.json");
  if (!data.mcpServers || !Object.hasOwn(data.mcpServers, SERVER_NAME))
    return { changed: false, file };
  backupFile(file);
  delete data.mcpServers[SERVER_NAME];
  atomicWrite(file, `${JSON.stringify(data, null, 2)}\n`);
  return { changed: true, file };
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
        const text = readText(file);
        connected = /\[mcp_servers\.leximeet\]/.test(text);
        if (connected) {
          const command = /command\s*=\s*"([^"]+)"/.exec(text)?.[1];
          broken = Boolean(command && !fs.existsSync(command));
        }
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
  return {
    id,
    status,
    installed,
    connected,
    broken,
    file,
    deeplink:
      id === "cursor" && electronExecutable && shimPath
        ? cursorDeeplink(launchConfig(electronExecutable, shimPath, "cursor"))
        : "",
    copyCommand: copyCommand(id, electronExecutable, shimPath),
  };
}

function cursorDeeplink(launch) {
  const config = Buffer.from(JSON.stringify(launch), "utf8").toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${SERVER_NAME}&config=${config}`;
}

function copyCommand(id, electronExecutable, shimPath) {
  if (!electronExecutable || !shimPath) return "";
  if (id === "codex")
    return `codex mcp add ${SERVER_NAME} -- ${quote(electronExecutable)} --run-as-node ${quote(shimPath)} --client codex`;
  if (id === "claude-code")
    return `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${quote(electronExecutable)} --run-as-node ${quote(shimPath)} --client claude-code`;
  return `cursor://anysphere.cursor-deeplink/mcp/install`;
}

function quote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function connect(id, options) {
  if (!CLIENTS.includes(id)) throw new Error("不支持的客户端");
  const launch = launchConfig(options.electronExecutable, options.shimPath, id);
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
      const result = spawnSync(
        cli,
        [
          "mcp",
          "add",
          SERVER_NAME,
          "--",
          options.electronExecutable,
          "--run-as-node",
          options.shimPath,
          "--client",
          "codex",
        ],
        { encoding: "utf8", env: options.env || process.env },
      );
      if (result.status === 0) return { method: "cli", ...inspectClient(id, options) };
    }
    return { method: "file", ...writeCodex(file, launch), ...inspectClient(id, options) };
  }
  const cli = commandOnPath("claude", options.env);
  if (cli && options.preferCli !== false) {
    const result = spawnSync(
      cli,
      [
        "mcp",
        "add",
        "--scope",
        "user",
        "--transport",
        "stdio",
        SERVER_NAME,
        "--",
        options.electronExecutable,
        "--run-as-node",
        options.shimPath,
        "--client",
        "claude-code",
      ],
      { encoding: "utf8", env: options.env || process.env },
    );
    if (result.status === 0) return { method: "cli", ...inspectClient(id, options) };
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
};
