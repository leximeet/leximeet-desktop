"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function assertPrivate(file, { directory = false } = {}) {
  const stat = fs.lstatSync(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o077
  )
    throw new Error("UNSAFE_PRIVATE_PATH");
  return stat;
}

function ensurePrivateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("INVALID_PRIVATE_PATH");
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertPrivate(directory, { directory: true });
  return directory;
}

function readPrivateJson(file, { maximumBytes = 65536 } = {}) {
  assertPrivate(path.dirname(file), { directory: true });
  const handle = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(handle);
    if (
      !stat.isFile() ||
      stat.size > maximumBytes ||
      stat.mode & 0o077 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("UNSAFE_PRIVATE_PATH");
    return require("./framing.cjs").parseStrictJson(fs.readFileSync(handle));
  } finally {
    fs.closeSync(handle);
  }
}

function writePrivateJson(file, value) {
  ensurePrivateDirectory(path.dirname(file));
  if (fs.existsSync(file)) assertPrivate(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = { assertPrivate, ensurePrivateDirectory, readPrivateJson, writePrivateJson };
