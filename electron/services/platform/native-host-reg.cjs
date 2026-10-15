"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { browserUserDataDir } = require("./app-paths.cjs");
const { windowsSystem32Binary } = require("./identity.cjs");

const HOST_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;

function registryKey(browser, hostName) {
  const hive =
    browser === "edge"
      ? "HKCU\\SOFTWARE\\Microsoft\\Edge\\NativeMessagingHosts"
      : "HKCU\\SOFTWARE\\Google\\Chrome\\NativeMessagingHosts";
  return `${hive}\\${hostName}`;
}

function runReg(args) {
  return execFileSync(windowsSystem32Binary("reg.exe"), args, {
    windowsHide: true,
    encoding: "utf8",
    timeout: 10000,
  });
}

function writeRegistryValue(key, value) {
  for (const view of ["32", "64"]) {
    runReg(["add", key, "/ve", "/t", "REG_SZ", "/d", value, "/f", `/reg:${view}`]);
  }
}

function readRegistryValue(key) {
  try {
    const out = runReg(["query", key, "/ve", "/reg:32"]);
    const match = /REG_SZ\s+(.+)$/m.exec(out);
    if (match) return match[1].trim();
  } catch {
    /* 再查 64 位视图 */
  }
  try {
    const out = runReg(["query", key, "/ve", "/reg:64"]);
    const match = /REG_SZ\s+(.+)$/m.exec(out);
    if (match) return match[1].trim();
  } catch {
    return "";
  }
  return "";
}

function removeRegistryValue(key) {
  for (const view of ["32", "64"]) {
    try {
      runReg(["delete", key, "/f", `/reg:${view}`]);
    } catch {
      /* 键不存在 */
    }
  }
}

function nativeManifestDir(browser, { platform = process.platform, homeDir, isolatedRoot } = {}) {
  if (isolatedRoot) return path.join(isolatedRoot, "NativeMessagingHosts");
  if (platform === "win32") return "";
  return path.join(browserUserDataDir(browser, { platform, homeDir }), "NativeMessagingHosts");
}

function assertHostName(hostName) {
  if (!HOST_NAME.test(hostName || "") || hostName.length > 100)
    throw new Error("INVALID_NATIVE_REGISTRATION");
}

module.exports = {
  HOST_NAME,
  registryKey,
  writeRegistryValue,
  readRegistryValue,
  removeRegistryValue,
  nativeManifestDir,
  assertHostName,
};
