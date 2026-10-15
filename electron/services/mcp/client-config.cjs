"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { randomBytes } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { quoteForShell } = require("../platform/shell-quote.cjs");
const { ensureLauncher, mcpLauncherPath } = require("../platform/launcher.cjs");
const { resolveClientBinary, commandOnPath } = require("../platform/process-names.cjs");

const SERVER_NAME = "leximeet";
const CLIENTS = Object.freeze(["cursor", "codex", "claude-code"]);
const quote = (text, platform = process.platform) => quoteForShell(text, platform);

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

function launcherPath(homeDir = os.homedir(), platform = process.platform) {
  return mcpLauncherPath({ homeDir: homeOf(homeDir), platform });
}

function launchConfig(electronExecutable, shimPath, homeDir, options = {}) {
  return {
    command: ensureLauncher({
      homeDir,
      electronExecutable,
      shimPath,
      platform: options.platform || process.platform,
      stubPath: options.stubPath,
      resourcesPath: options.resourcesPath,
      projectDir: options.projectDir,
      env: options.env,
      appData: options.appData,
    }),
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

function readTomlKey(source, start) {
  const quote = source[start];
  if (quote === '"' || quote === "'") {
    let text = "";
    let escape = false;
    for (let i = start + 1; i < source.length; i++) {
      const ch = source[i];
      if (quote === '"' && escape) {
        text += ch;
        escape = false;
        continue;
      }
      if (quote === '"' && ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === quote) return { value: text, next: i + 1 };
      text += ch;
    }
    return null;
  }
  const match = /^[A-Za-z0-9_-]+/.exec(source.slice(start));
  return match ? { value: match[0], next: start + match[0].length } : null;
}

function skipTomlSpace(source, start) {
  let i = start;
  while (source[i] === " " || source[i] === "\t") i++;
  return i;
}

/** 解析 TOML 表头：空白、行尾注释、引号键名、[[数组表]]。 */
function parseTomlHeader(line) {
  const text = String(line);
  let i = skipTomlSpace(text, 0);
  if (text[i] !== "[") return null;
  const array = text[i + 1] === "[";
  i += array ? 2 : 1;
  const keys = [];
  while (true) {
    i = skipTomlSpace(text, i);
    const key = readTomlKey(text, i);
    if (!key) return null;
    keys.push(key.value);
    i = skipTomlSpace(text, key.next);
    if (text[i] === ".") {
      i += 1;
      continue;
    }
    break;
  }
  if (array) {
    if (text[i] !== "]" || text[i + 1] !== "]") return null;
    i += 2;
  } else if (text[i] === "]") i += 1;
  else return null;
  i = skipTomlSpace(text, i);
  if (i < text.length && text[i] !== "#") return null;
  return keys.length ? { array, keys } : null;
}

function isLeximeetTomlTable(header, name) {
  return header && !header.array && header.keys[0] === "mcp_servers" && header.keys[1] === name;
}

function findTomlTables(source, name) {
  const lines = source.split(/\r?\n/);
  const ranges = [];
  let start = -1;
  for (let i = 0; i <= lines.length; i++) {
    const header = i < lines.length ? parseTomlHeader(lines[i]) : null;
    if (i === lines.length || header) {
      if (start >= 0) {
        ranges.push([start, i]);
        start = -1;
      }
      if (isLeximeetTomlTable(header, name)) start = i;
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

function inspectClient(id, options = {}) {
  const { homeDir, electronExecutable, shimPath, env = process.env } = options;
  const file = paths(homeDir)[id];
  const installed = fs.existsSync(path.dirname(file)) || Boolean(resolveClientBinary(id, { env }));
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
    electronExecutable && shimPath
      ? launchConfig(electronExecutable, shimPath, homeDir, options)
      : null;
  return {
    id,
    status,
    installed,
    connected,
    broken,
    file,
    deeplink: id === "cursor" && desired ? cursorDeeplink(desired) : "",
    copyCommand: desired ? copyCommand(id, desired, process.platform) : "",
  };
}

function cursorDeeplink(launch) {
  const config = Buffer.from(
    JSON.stringify({ command: launch.command, args: launch.args || [] }),
    "utf8",
  ).toString("base64");
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(SERVER_NAME)}&config=${encodeURIComponent(config)}`;
}

function copyCommand(id, launch, platform = process.platform) {
  if (!launch?.command) return "";
  const q = (value) => quote(value, platform);
  if (id === "codex") return `codex mcp add ${SERVER_NAME} -- ${q(launch.command)}`;
  if (id === "claude-code")
    return `claude mcp add --scope user --transport stdio ${SERVER_NAME} -- ${q(launch.command)}`;
  return cursorDeeplink(launch);
}

function connectWithCli(cli, args, env) {
  return spawnSync(cli, args, { encoding: "utf8", env: env || process.env });
}

function connect(id, options) {
  if (!CLIENTS.includes(id)) throw new Error("不支持的客户端");
  const launch = launchConfig(
    options.electronExecutable,
    options.shimPath,
    options.homeDir,
    options,
  );
  const file = paths(options.homeDir)[id];
  if (id === "cursor") {
    if (options.preferDeeplink && options.openExternal) {
      options.openExternal(cursorDeeplink(launch));
      return { method: "deeplink", ...inspectClient(id, options) };
    }
    return { method: "file", ...writeCursor(file, launch), ...inspectClient(id, options) };
  }
  if (id === "codex") {
    const cli = resolveClientBinary("codex", { env: options.env });
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
  const cli = resolveClientBinary("claude-code", { env: options.env });
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
  parseTomlHeader,
  leximeetTomlText,
};
