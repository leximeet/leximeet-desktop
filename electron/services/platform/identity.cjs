"use strict";
const os = require("node:os");
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

function currentWindowsSid() {
  if (process.platform !== "win32") return "";
  try {
    const out = execFileSync("whoami", ["/user"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    const match = /(S-1-5-[0-9-]+)/.exec(out);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

function currentWindowsAccount() {
  if (process.platform !== "win32") return currentUsername();
  try {
    const out = execFileSync("whoami", [], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    return out.trim() || currentUsername();
  } catch {
    return currentUsername();
  }
}

module.exports = {
  currentUsername,
  currentUserKey,
  currentWindowsSid,
  currentWindowsAccount,
};
