"use strict";
const fs = require("node:fs");
const path = require("node:path");

const BINARIES = Object.freeze({
  cursor: { posix: "cursor", win32: "cursor.exe" },
  codex: { posix: "codex", win32: "codex.exe" },
  "claude-code": { posix: "claude", win32: "claude.exe" },
});

function commandNames(id, platform = process.platform) {
  const spec = BINARIES[id];
  if (!spec) return [];
  return platform === "win32" ? [spec.win32, spec.posix] : [spec.posix];
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

function commonInstallCandidates(id, { platform = process.platform, env = process.env } = {}) {
  if (platform !== "win32") return [];
  const local = env.LOCALAPPDATA || "";
  if (!local) return [];
  if (id === "cursor") return [path.join(local, "Programs", "cursor", "Cursor.exe")];
  if (id === "claude-code") return [path.join(local, "Programs", "Claude", "claude.exe")];
  return [];
}

function resolveClientBinary(id, { platform = process.platform, env = process.env } = {}) {
  for (const name of commandNames(id, platform)) {
    const found = commandOnPath(name, env);
    if (found) return found;
  }
  for (const candidate of commonInstallCandidates(id, { platform, env })) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

module.exports = {
  BINARIES,
  commandNames,
  commandOnPath,
  commonInstallCandidates,
  resolveClientBinary,
};
