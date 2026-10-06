#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const {
  assertPrivate,
  readPrivateJson,
} = require("../../electron/services/lmcp/private-files.cjs");
const { registerNativeHost } = require("../../electron/services/lmcp/native-registration.cjs");

const FLAGS = new Set([
  "--profile-root",
  "--browser-root",
  "--extension-id",
  "--electron",
  "--host-script",
]);
const HELP = `词遇隔离 Native Host 注册（仅 macOS，不会启动浏览器）

node scripts/lmcp/register-host.cjs \\
  --profile-root /绝对路径/隔离Desktop资料根 \\
  --browser-root /绝对路径/隔离Desktop资料根/browser-profile/chrome \\
  --extension-id 32位扩展ID \\
  --electron /随包Electron.app/Contents/MacOS/Electron \\
  --host-script /外置资源/native-host/host/main.cjs

Desktop 根必须已存在私有 profile.json，profile 为 test、demo 或 preview。
浏览器根必须位于该隔离根内；固定注册名 org.leximeet.browser。
只更新本资料根以前登记且内容未被其他程序改动的注册。
`;

// 所有输入显式给出，禁止回退到日常浏览器、系统 Node 或旧 Host。
function parseArguments(argv) {
  if (argv.length === 1 && argv[0] === "--help") return null;
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!FLAGS.has(flag) || Object.hasOwn(options, flag) || !value || value.startsWith("--"))
      throw new Error("INVALID_NATIVE_ARGUMENTS");
    options[flag] = value;
  }
  if (Object.keys(options).length !== FLAGS.size)
    throw new Error("EXPLICIT_NATIVE_ARGUMENTS_REQUIRED");
  return {
    profileRoot: options["--profile-root"],
    browserDataDir: options["--browser-root"],
    extensionId: options["--extension-id"],
    electronExecutable: options["--electron"],
    hostScript: options["--host-script"],
  };
}

// 尚未创建的子目录也按现有祖先的真实路径检查，不能借 symlink 指向日常 Chrome。
function assertContainedBrowserRoot(profileRoot, browserDataDir) {
  if (!path.isAbsolute(browserDataDir || "") || /[\0\r\n]/.test(browserDataDir))
    throw new Error("INVALID_NATIVE_PATH");
  const profileReal = fs.realpathSync(profileRoot);
  const browserResolved = path.resolve(browserDataDir);
  const relative = path.relative(path.resolve(profileRoot), browserResolved);
  if (
    !relative ||
    relative.startsWith(".." + path.sep) ||
    relative === ".." ||
    path.isAbsolute(relative)
  )
    throw new Error("ISOLATED_BROWSER_REQUIRED");
  let existing = browserResolved;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = fs.realpathSync(existing);
  const actualRelative = path.relative(profileReal, real);
  if (
    actualRelative.startsWith(".." + path.sep) ||
    actualRelative === ".." ||
    path.isAbsolute(actualRelative)
  )
    throw new Error("ISOLATED_BROWSER_REQUIRED");
  // 即便最终指向隔离根，目录软链接也不参与浏览器注册，减少路径歧义。
  let current = path.resolve(profileRoot);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
      throw new Error("ISOLATED_BROWSER_REQUIRED");
  }
  if (fs.existsSync(browserResolved)) assertPrivate(browserResolved, { directory: true });
}

function registerIsolatedHost(input) {
  if (!path.isAbsolute(input?.profileRoot || "") || /[\0\r\n]/.test(input.profileRoot))
    throw new Error("INVALID_NATIVE_PATH");
  assertPrivate(input.profileRoot, { directory: true });
  const marker = readPrivateJson(path.join(input.profileRoot, "profile.json"));
  if (!["test", "demo", "preview"].includes(marker.profile))
    throw new Error("ISOLATED_PROFILE_MARKER_REQUIRED");
  assertContainedBrowserRoot(input.profileRoot, input.browserDataDir);
  const registration = registerNativeHost({
    ...input,
    profileName: marker.profile,
    isolated: true,
    hostName: "org.leximeet.browser",
  });
  // stdout 只提供验收脚本所需路径，不回传 Socket 凭据或 session/grant。
  return {
    registered: true,
    isolated: true,
    hostName: registration.hostName,
    profile: marker.profile,
    browserDataDir: registration.browserDataDir,
    manifestPath: registration.manifestPath,
    recordPath: registration.recordPath,
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const input = parseArguments(argv);
    if (!input) {
      process.stdout.write(HELP);
      return;
    }
    process.stdout.write(JSON.stringify(registerIsolatedHost(input)) + "\n");
  } catch (error) {
    const code = /^[A-Z][A-Z0-9_]+$/.test(error.message || "")
      ? error.message
      : "INVALID_NATIVE_CONFIGURATION";
    process.stderr.write(`Native Host 注册失败：${code}。使用 --help 查看隔离注册要求。\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { parseArguments, registerIsolatedHost, assertContainedBrowserRoot, main };
