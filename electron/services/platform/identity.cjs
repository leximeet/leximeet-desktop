"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");

function currentUsername() {
  try {
    return os.userInfo().username || "user";
  } catch {
    return process.env.USERNAME || process.env.USER || "user";
  }
}

/** 管道名 / 临时目录只用短 ASCII，避免中文用户名超长。 */
function currentUserKey(platform = process.platform) {
  if (platform !== "win32" && typeof process.getuid === "function") return String(process.getuid());
  const sid = currentWindowsSid();
  if (sid) return createHash("sha256").update(sid).digest("hex").slice(0, 8);
  return createHash("sha256").update(currentUsername()).digest("hex").slice(0, 8);
}

/** 固定 %SystemRoot%\System32，不依赖 PATH，也不在测试里补 PATH。 */
function windowsSystem32Binary(name) {
  const file = String(name).toLowerCase().endsWith(".exe") ? name : `${name}.exe`;
  const roots = [process.env.SystemRoot, process.env.WINDIR, "C:\\Windows"].filter(Boolean);
  const candidates = roots.map((root) => path.join(root, "System32", file));
  if (process.platform !== "win32") return candidates[0];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`WINDOWS_SYSTEM32_MISSING:${file}`);
}

function windowsWhoami(args = []) {
  return execFileSync(windowsSystem32Binary("whoami.exe"), args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
}

function currentWindowsSid() {
  if (process.platform !== "win32") return "";
  try {
    const match = /(S-1-5-[0-9-]+)/.exec(windowsWhoami(["/user"]));
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function currentWindowsAccount() {
  if (process.platform !== "win32") return currentUsername();
  try {
    return windowsWhoami().trim() || currentUsername();
  } catch {
    return currentUsername();
  }
}

module.exports = {
  currentUsername,
  currentUserKey,
  currentWindowsSid,
  currentWindowsAccount,
  windowsSystem32Binary,
};
