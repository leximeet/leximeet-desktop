"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  ensurePrivateDirectory,
  writePrivateJson,
} = require("../../electron/services/platform/private-files.cjs");

/** 隔离资料根必须先收紧 ACL；Windows 工作区 TEMP 默认含 Users，mkdir 0o700 不够。 */
function isolatedProfile(t, { prefix = "leximeet-isolated-", marker = { profile: "test" } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const profileRoot = path.join(root, "desktop");
  ensurePrivateDirectory(root);
  ensurePrivateDirectory(profileRoot);
  if (marker) writePrivateJson(path.join(profileRoot, "profile.json"), marker);
  t.after(() => {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 24, retryDelay: 100 });
    } catch (error) {
      if (!["EPERM", "EBUSY", "ENOENT"].includes(error.code)) throw error;
    }
  });
  return { root, profileRoot };
}

module.exports = { isolatedProfile };
