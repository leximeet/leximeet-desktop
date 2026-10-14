"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { posixQuote } = require("./shell-quote.cjs");
const { mcpLauncherPath, mcpDir } = require("./app-paths.cjs");
const { ensurePrivateDirectory } = require("./private-files.cjs");

function findPeStub({ stubPath, resourcesPath, projectDir } = {}) {
  const candidates = [
    stubPath,
    resourcesPath && path.join(resourcesPath, "native", "leximeet-run-as-node.exe"),
    projectDir && path.join(projectDir, "resources", "native", "leximeet-run-as-node.exe"),
    projectDir && path.join(projectDir, ".runtime", "native", "leximeet-run-as-node.exe"),
  ].filter(Boolean);
  for (const file of candidates) if (fs.existsSync(file)) return file;
  return "";
}

function writeLaunchSidecar(launcher, { electronExecutable, shimPath, prefixArgs = [] }) {
  const lines = [`electron=${electronExecutable}`, `script=${shimPath}`];
  for (const arg of prefixArgs) lines.push(`arg=${arg}`);
  const sidecar = `${launcher}.launch`;
  fs.writeFileSync(sidecar, `${lines.join("\n")}\n`, { mode: 0o600 });
  return sidecar;
}

function ensurePosixLauncher({ homeDir, electronExecutable, shimPath, prefixArgs = [], platform }) {
  const file = mcpLauncherPath({ homeDir, platform });
  ensurePrivateDirectory(path.dirname(file));
  const extras = prefixArgs.map((arg) => posixQuote(arg)).join(" ");
  const text = [
    "#!/bin/sh",
    "# 词遇管理的 MCP 转发：随包 Electron 的 Node 模式，无需系统 Node/JDK。",
    "unset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR ELECTRON_ENABLE_LOGGING ELECTRON_LOG_FILE",
    "export ELECTRON_RUN_AS_NODE=1",
    `exec ${posixQuote(electronExecutable)} ${posixQuote(shimPath)}${extras ? ` ${extras}` : ""} "$@"`,
    "",
  ].join("\n");
  fs.writeFileSync(file, text, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

function ensureWindowsLauncher({
  homeDir,
  electronExecutable,
  shimPath,
  prefixArgs = [],
  stubPath,
  resourcesPath,
  projectDir,
}) {
  const stub = findPeStub({ stubPath, resourcesPath, projectDir });
  if (!stub) throw new Error("WINDOWS_PE_STUB_MISSING");
  const file = mcpLauncherPath({ homeDir, platform: "win32" });
  ensurePrivateDirectory(path.dirname(file), { platform: "win32" });
  fs.copyFileSync(stub, file);
  writeLaunchSidecar(file, { electronExecutable, shimPath, prefixArgs });
  return file;
}

function writeNativeLauncher({
  launcher,
  electronExecutable,
  hostScript,
  descriptorPath,
  platform = process.platform,
  stubPath,
  resourcesPath,
  projectDir,
}) {
  if (platform === "win32") {
    const stub = findPeStub({ stubPath, resourcesPath, projectDir });
    if (!stub) throw new Error("WINDOWS_PE_STUB_MISSING");
    fs.copyFileSync(stub, launcher);
    writeLaunchSidecar(launcher, {
      electronExecutable,
      shimPath: hostScript,
      prefixArgs: [descriptorPath],
    });
    return launcher;
  }
  const text = `#!/bin/sh\n# 词遇管理的 Native Host：随包运行时，无需系统 Node/JDK。\nunset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR ELECTRON_ENABLE_LOGGING ELECTRON_LOG_FILE\nexport ELECTRON_RUN_AS_NODE=1\nexec ${posixQuote(electronExecutable)} ${posixQuote(hostScript)} ${posixQuote(descriptorPath)} "$@"\n`;
  fs.writeFileSync(launcher, text, { mode: 0o700, flag: fs.existsSync(launcher) ? "w" : "wx" });
  fs.chmodSync(launcher, 0o700);
  return launcher;
}

function ensureLauncher({
  homeDir,
  electronExecutable,
  shimPath,
  prefixArgs = [],
  platform = process.platform,
  stubPath,
  resourcesPath,
  projectDir,
}) {
  if (!path.isAbsolute(electronExecutable || "") || !path.isAbsolute(shimPath || ""))
    throw new Error("MCP_LAUNCH_PATHS_MUST_BE_ABSOLUTE");
  if (platform === "win32")
    return ensureWindowsLauncher({
      homeDir,
      electronExecutable,
      shimPath,
      prefixArgs,
      stubPath,
      resourcesPath,
      projectDir,
    });
  return ensurePosixLauncher({ homeDir, electronExecutable, shimPath, prefixArgs, platform });
}

function readLaunchSidecar(launcher) {
  const sidecar = `${launcher}.launch`;
  if (!fs.existsSync(sidecar)) return null;
  const values = { electron: "", script: "", prefixArgs: [] };
  for (const line of fs.readFileSync(sidecar, "utf8").split(/\r?\n/)) {
    if (line.startsWith("electron=")) values.electron = line.slice("electron=".length);
    else if (line.startsWith("script=")) values.script = line.slice("script=".length);
    else if (line.startsWith("arg=")) values.prefixArgs.push(line.slice("arg=".length));
  }
  return values;
}

module.exports = {
  findPeStub,
  writeLaunchSidecar,
  writeNativeLauncher,
  readLaunchSidecar,
  ensureLauncher,
  mcpLauncherPath,
  mcpDir,
};
