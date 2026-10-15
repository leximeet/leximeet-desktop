"use strict";
const { randomUUID } = require("node:crypto");
const { unregisterNativeHost } = require("../../electron/services/lmcp/native-registration.cjs");
const {
  registryKey,
  removeRegistryValue,
} = require("../../electron/services/platform/native-host-reg.cjs");

function uniqueTestHostName() {
  return `org.leximeet.browser.test.${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function cleanupNativeRegistration(registration) {
  if (!registration) return;
  try {
    unregisterNativeHost(registration);
    return;
  } catch {
    /* 记录文件可能已坏，仍按名字清 HKCU */
  }
  if (process.platform === "win32" && registration.hostName) {
    try {
      removeRegistryValue(registryKey(registration.browser || "chrome", registration.hostName));
    } catch {
      /* 键不存在 */
    }
  }
}

/** 清掉上一轮共用名残留，避免 HKCU 撞车连锁失败。 */
function forgetSharedTestHost() {
  if (process.platform !== "win32") return;
  try {
    removeRegistryValue(registryKey("chrome", "org.leximeet.browser.test"));
  } catch {
    /* 无上一轮共用名 */
  }
}

module.exports = { uniqueTestHostName, cleanupNativeRegistration, forgetSharedTestHost };
