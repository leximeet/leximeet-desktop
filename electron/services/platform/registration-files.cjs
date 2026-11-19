"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { assertNotReparse, assertPosixPrivate, assertPrivate } = require("./private-files.cjs");
const { parseStrictJson } = require("../lmcp/framing.cjs");

/**
 * POSIX 浏览器的 NativeMessagingHosts 是多个应用共用的登记目录。
 * 允许本用户拥有的 0755/0700，但拒绝其他用户可写、符号链接及外来所有者。
 * 目录中不放令牌；词遇自己的清单仍为 0600，秘密和启动器仍放私有目录。
 */
function assertRegistrationDirectory(directory) {
  const stat = assertNotReparse(directory);
  if (
    !stat.isDirectory() ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
    stat.mode & 0o022
  )
    throw new Error("UNSAFE_NATIVE_REGISTRATION_DIRECTORY");
  return stat;
}

function ensureRegistrationDirectory(directory) {
  if (!path.isAbsolute(directory)) throw new Error("INVALID_NATIVE_PATH");
  if (!fs.existsSync(directory)) {
    let parent = path.dirname(directory);
    while (!fs.existsSync(parent)) parent = path.dirname(parent);
    // 先检查现存祖先，不能先沿外部软链接创建目录再报错。
    assertNotReparse(parent);
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
  }
  // 不 chmod 既有共享目录，也不改变其他应用的登记文件。
  assertRegistrationDirectory(directory);
}

function readRegistrationJson(file) {
  assertRegistrationDirectory(path.dirname(file));
  assertPrivate(file);
  const handle = fs.openSync(
    file,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0),
  );
  try {
    const stat = fs.fstatSync(handle);
    assertPosixPrivate(stat);
    if (stat.size > 65536) throw new Error("UNSAFE_PRIVATE_PATH");
    return parseStrictJson(fs.readFileSync(handle));
  } finally {
    fs.closeSync(handle);
  }
}

function writeRegistrationJson(file, value) {
  ensureRegistrationDirectory(path.dirname(file));
  if (fs.existsSync(file)) assertPrivate(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

module.exports = {
  assertRegistrationDirectory,
  ensureRegistrationDirectory,
  readRegistrationJson,
  writeRegistrationJson,
};
