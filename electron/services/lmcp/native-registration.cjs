"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const {
  ensurePrivateDirectory,
  readPrivateJson,
  writePrivateJson,
  assertPrivate,
} = require("./private-files.cjs");
const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const HOST_NAME = /^[a-z0-9_]+(?:\.[a-z0-9_]+)+$/;
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 读取随包二进制的 fuse，而不试运行一个可能抢占前台的 Electron UI。
function assertRunAsNodeEnabled(executable) {
  const sentinel = Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX");
  // macOS 的启动器很小，真正的 fuse 位于 Electron Framework；正式改名的 app 同理。
  const appAt = executable.indexOf(".app/");
  const fuseFile =
    appAt < 0
      ? executable
      : path.join(
          executable.slice(0, appAt + 4),
          "Contents",
          "Frameworks",
          "Electron Framework.framework",
          "Electron Framework",
        );
  const fd = fs.openSync(fuseFile, "r");
  try {
    let position = 0;
    let previous = Buffer.alloc(0);
    const chunk = Buffer.alloc(65536);
    const found = new Set();
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, position);
      if (!n) break;
      position += n;
      const combined = Buffer.concat([previous, chunk.subarray(0, n)]);
      let at = combined.indexOf(sentinel);
      while (at >= 0 && at + sentinel.length + 3 <= combined.length) {
        const absoluteAt = position - n - previous.length + at;
        const wire = at + sentinel.length;
        if (!found.has(absoluteAt)) {
          if (combined[wire] !== 1 || combined[wire + 1] < 1 || combined[wire + 2] !== 0x31)
            throw new Error("ELECTRON_RUN_AS_NODE_DISABLED");
          found.add(absoluteAt);
        }
        at = combined.indexOf(sentinel, at + sentinel.length);
      }
      previous = combined.subarray(Math.max(0, combined.length - sentinel.length - 8));
    }
    if (!found.size) throw new Error("ELECTRON_FUSE_NOT_FOUND");
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * 仅生成当前 Desktop 所有的用户级注册；隔离测试必须明确指定测试浏览器根目录。
 * Host 使用随包 Electron 的 Node 模式，不依赖用户机器上的 Node / JDK。
 */
function registerNativeHost({
  extensionId,
  extensionIds = [extensionId],
  browserDataDir,
  profileRoot,
  electronExecutable,
  hostScript,
  hostName = "org.leximeet.browser",
  platform = process.platform,
  isolated = false,
  profileName = "local",
  allowDailyRegistration = false,
}) {
  if (platform !== "darwin") throw new Error("NATIVE_REGISTRATION_MACOS_ONLY");
  if (
    !Array.isArray(extensionIds) ||
    !extensionIds.length ||
    extensionIds.length > 64 ||
    extensionIds.some((id) => !/^[a-p]{32}$/.test(id || "")) ||
    new Set(extensionIds).size !== extensionIds.length ||
    (extensionId !== undefined && extensionId !== extensionIds[0]) ||
    !HOST_NAME.test(hostName) ||
    hostName.length > 100
  )
    throw new Error("INVALID_NATIVE_REGISTRATION");
  if (profileName !== "local" && !isolated) throw new Error("ISOLATED_BROWSER_REQUIRED");
  if (!isolated && !allowDailyRegistration)
    throw new Error("EXPLICIT_BROWSER_REGISTRATION_REQUIRED");
  for (const item of [browserDataDir, profileRoot, electronExecutable, hostScript])
    if (!path.isAbsolute(item || "") || /[\0\r\n]/.test(item))
      throw new Error("INVALID_NATIVE_PATH");
  if (!fs.existsSync(hostScript) || !fs.statSync(hostScript).isFile())
    throw new Error("NATIVE_HOST_SCRIPT_MISSING");
  assertRunAsNodeEnabled(electronExecutable);
  const directory = path.join(profileRoot, "native-messaging");
  ensurePrivateDirectory(directory);
  const records = path.join(directory, "registrations");
  ensurePrivateDirectory(records);
  const key = digest(`${browserDataDir}\n${hostName}`).slice(0, 32);
  const recordPath = path.join(records, `${key}.json`);
  const launcher = path.join(directory, `${hostName}-${key}.sh`);
  const manifestPath = path.join(browserDataDir, "NativeMessagingHosts", `${hostName}.json`);
  const descriptorPath = path.join(directory, "lmcp-uds.json");
  const firstInstall = !fs.existsSync(recordPath);
  if (fs.existsSync(manifestPath) || fs.existsSync(launcher)) {
    if (!fs.existsSync(recordPath)) throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
    assertRegistrationOwnership(readPrivateJson(recordPath));
  }
  ensurePrivateDirectory(path.dirname(manifestPath));
  const origins = extensionIds.map((id) => `chrome-extension://${id}/`);
  const origin = origins[0];
  // 只接受浏览器补充的来源参数；清除能注入 Node 代码或改变 ASAR 读取的环境变量。
  const launcherText = `#!/bin/sh\n# 词遇管理的 Native Host：随包运行时，无需系统 Node/JDK。\nunset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR ELECTRON_ENABLE_LOGGING ELECTRON_LOG_FILE\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(electronExecutable)} ${quote(hostScript)} ${quote(descriptorPath)} "$@"\n`;
  const manifest = {
    name: hostName,
    description: "词遇本机工作区连接",
    path: launcher,
    type: "stdio",
    allowed_origins: origins,
  };
  const created = [];
  try {
    fs.writeFileSync(launcher, launcherText, { mode: 0o700, flag: firstInstall ? "wx" : "w" });
    if (firstInstall) created.push(launcher);
    fs.chmodSync(launcher, 0o700);
    if (firstInstall) {
      // 另一份 Desktop 同时注册同一浏览器目录时，由 O_EXCL 裁决，不能 rename 覆盖它。
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", {
        mode: 0o600,
        flag: "wx",
      });
      created.push(manifestPath);
    } else writePrivateJson(manifestPath, manifest);
    const registration = {
      format: "leximeet.native-registration/1",
      profileRoot,
      profileName,
      browserDataDir,
      hostName,
      origin,
      origins,
      launcher,
      descriptorPath,
      manifestPath,
      recordPath,
      isolated,
      launcherSha256: digest(fs.readFileSync(launcher)),
      manifestSha256: digest(fs.readFileSync(manifestPath)),
    };
    writePrivateJson(recordPath, registration);
    return registration;
  } catch (error) {
    // 只回滚本次独占创建的文件；从未改写已有的浏览器注册。
    for (const file of created.reverse()) fs.rmSync(file, { force: true });
    throw error;
  }
}

function assertRegistrationOwnership(record) {
  if (
    record?.format !== "leximeet.native-registration/1" ||
    !HOST_NAME.test(record.hostName || "") ||
    !ORIGIN.test(record.origin || "") ||
    !Array.isArray(record.origins) ||
    !record.origins.length ||
    record.origins.length > 64 ||
    record.origins[0] !== record.origin ||
    record.origins.some((origin) => !ORIGIN.test(origin)) ||
    new Set(record.origins).size !== record.origins.length ||
    !path.isAbsolute(record.profileRoot || "") ||
    !path.isAbsolute(record.browserDataDir || "")
  )
    throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
  const key = digest(`${record.browserDataDir}\n${record.hostName}`).slice(0, 32);
  if (
    record.manifestPath !==
      path.join(record.browserDataDir, "NativeMessagingHosts", `${record.hostName}.json`) ||
    record.launcher !==
      path.join(record.profileRoot, "native-messaging", `${record.hostName}-${key}.sh`) ||
    record.recordPath !==
      path.join(record.profileRoot, "native-messaging", "registrations", `${key}.json`) ||
    record.descriptorPath !== path.join(record.profileRoot, "native-messaging", "lmcp-uds.json")
  )
    throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
  for (const [file, hash] of [
    [record.manifestPath, record.manifestSha256],
    [record.launcher, record.launcherSha256],
  ]) {
    if (!fs.existsSync(file)) throw new Error("NATIVE_REGISTRATION_CHANGED");
    assertPrivate(path.dirname(file), { directory: true });
    const stat = assertPrivate(file);
    if (
      stat.size > 65536 ||
      !/^[a-f0-9]{64}$/.test(hash || "") ||
      digest(fs.readFileSync(file)) !== hash
    )
      throw new Error("NATIVE_REGISTRATION_CHANGED");
  }
  const manifest = readPrivateJson(record.manifestPath);
  if (
    manifest.name !== record.hostName ||
    manifest.path !== record.launcher ||
    manifest.type !== "stdio" ||
    !Array.isArray(manifest.allowed_origins) ||
    JSON.stringify(manifest.allowed_origins) !== JSON.stringify(record.origins)
  )
    throw new Error("NATIVE_REGISTRATION_CHANGED");
  return true;
}

function unregisterNativeHost(input) {
  if (!input?.recordPath) throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
  const record = readPrivateJson(input.recordPath);
  assertRegistrationOwnership(record);
  if (record.profileRoot !== input.profileRoot || record.manifestPath !== input.manifestPath)
    throw new Error("NATIVE_REGISTRATION_NOT_OWNED");
  fs.rmSync(record.manifestPath);
  fs.rmSync(record.launcher);
  fs.rmSync(record.recordPath);
  return { uninstalled: true, hostName: record.hostName };
}

module.exports = {
  registerNativeHost,
  unregisterNativeHost,
  assertRegistrationOwnership,
  assertRunAsNodeEnabled,
};
