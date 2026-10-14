"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { protectWindowsPath, assertWindowsPrivate } = require("./win32-acl.cjs");

/** macOS 把 /tmp、/var 链到 /private；这是系统前缀，不是攻击者替换。 */
const DARWIN_SYSTEM_SYMLINKS = new Map([
  ["/tmp", "/private/tmp"],
  ["/var", "/private/var"],
]);

function isDarwinSystemSymlink(lexical, real) {
  if (process.platform !== "darwin") return false;
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/\/$/, "");
    return resolved || "/";
  };
  return DARWIN_SYSTEM_SYMLINKS.get(normalize(lexical)) === normalize(real);
}

function assertNotReparse(file) {
  const resolved = path.resolve(file);
  const parts = resolved.split(path.sep).filter(Boolean);
  let cursor = process.platform === "win32" ? `${parts.shift()}${path.sep}` : path.sep;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isSymbolicLink()) continue;
    const real = fs.realpathSync.native(cursor);
    if (!isDarwinSystemSymlink(cursor, real)) throw new Error("UNSAFE_PRIVATE_PATH");
    cursor = real;
  }
  const stat = fs.lstatSync(cursor);
  if (stat.isSymbolicLink()) throw new Error("UNSAFE_PRIVATE_PATH");
  return stat;
}

function assertPosixPrivate(stat, { directory = false } = {}) {
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  )
    throw new Error("UNSAFE_PRIVATE_PATH");
}

function assertPrivate(file, { directory = false, platform = process.platform } = {}) {
  const stat = assertNotReparse(file);
  if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error("UNSAFE_PRIVATE_PATH");
  if (platform === "win32") {
    assertWindowsPrivate(file);
    return stat;
  }
  assertPosixPrivate(stat, { directory });
  return stat;
}

function ensurePrivateDirectory(directory, { platform = process.platform } = {}) {
  if (!path.isAbsolute(directory)) throw new Error("INVALID_PRIVATE_PATH");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (platform === "win32") protectWindowsPath(directory);
  assertPrivate(directory, { directory: true, platform });
  return directory;
}

function readPrivateJson(file, { maximumBytes = 65536, platform = process.platform } = {}) {
  assertPrivate(path.dirname(file), { directory: true, platform });
  const nofollow = fs.constants.O_NOFOLLOW || 0;
  const handle = fs.openSync(file, fs.constants.O_RDONLY | nofollow);
  try {
    const stat = fs.fstatSync(handle);
    if (!stat.isFile() || stat.size > maximumBytes) throw new Error("UNSAFE_PRIVATE_PATH");
    if (platform === "win32") assertWindowsPrivate(file);
    else assertPosixPrivate(stat);
    return require("../lmcp/framing.cjs").parseStrictJson(fs.readFileSync(handle));
  } finally {
    fs.closeSync(handle);
  }
}

function writePrivateJson(file, value, { platform = process.platform } = {}) {
  ensurePrivateDirectory(path.dirname(file), { platform });
  if (fs.existsSync(file)) assertPrivate(file, { platform });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    if (platform === "win32") protectWindowsPath(temporary);
    fs.renameSync(temporary, file);
    if (platform === "win32") protectWindowsPath(file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = {
  assertPrivate,
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
  isDarwinSystemSymlink,
};
