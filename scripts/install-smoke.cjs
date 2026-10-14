"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { backgroundEnvironment } = require("../tests/helpers/background-environment.cjs");
const { mcpLauncherPath } = require("../electron/services/platform/app-paths.cjs");
const { signalTree } = require("../electron/services/platform/process-tree.cjs");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 180000,
    windowsHide: true,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw (
      result.error ||
      new Error(
        `${path.basename(command)} 返回 ${result.status}: ${result.stderr || result.stdout}`,
      )
    );
  return result;
}

function kindOf(installer, requested) {
  if (requested) return requested;
  if (/\.exe$/i.test(installer)) return "nsis";
  if (/\.deb$/i.test(installer)) return "deb";
  if (/\.AppImage$/i.test(installer)) return "appimage";
  if (/\.dmg$/i.test(installer)) return "dmg";
  throw new Error("无法识别安装包类型");
}

function install(installer, kind) {
  if (kind === "nsis") {
    run(installer, ["/S"], { windowsVerbatimArguments: true, shell: false });
    const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "LexiMeet", "LexiMeet.exe");
    if (!fs.existsSync(exe)) throw new Error(`NSIS 安装后缺少 ${exe}`);
    return { exe, uninstall: () => uninstallNsis() };
  }
  if (kind === "deb") {
    run("sudo", ["apt-get", "update", "-qq"]);
    run("sudo", ["apt-get", "install", "-y", installer]);
    const exe = ["/opt/LexiMeet/leximeet", "/opt/leximeet/leximeet"].find((file) =>
      fs.existsSync(file),
    );
    if (!exe) throw new Error("deb 安装后缺少 /opt/LexiMeet/leximeet");
    return { exe, uninstall: () => run("sudo", ["apt-get", "remove", "-y", "leximeet"]) };
  }
  if (kind === "appimage") {
    const copy = path.join(os.tmpdir(), `LexiMeet-smoke-${Date.now()}.AppImage`);
    fs.copyFileSync(installer, copy);
    fs.chmodSync(copy, 0o755);
    const extract = process.env.LEXIMEET_APPIMAGE_EXTRACT === "1" || !fs.existsSync("/dev/fuse");
    return {
      exe: copy,
      args: extract ? ["--appimage-extract-and-run"] : [],
      uninstall: () => fs.rmSync(copy, { force: true }),
    };
  }
  throw new Error(`不支持的安装类型：${kind}`);
}

function uninstallNsis() {
  const uninstaller = path.join(
    process.env.LOCALAPPDATA || "",
    "Programs",
    "LexiMeet",
    "Uninstall LexiMeet.exe",
  );
  if (!fs.existsSync(uninstaller)) throw new Error("缺少 NSIS 卸载器");
  run(uninstaller, ["/S"], { windowsVerbatimArguments: true });
}

async function waitFor(predicate, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`${label} 超时`);
}

async function runMcp(descriptorPath, command, args, env) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const transport = new StdioClientTransport({
    command,
    args: args || [],
    stderr: "pipe",
    env: { ...env, LEXIMEET_MCP_DESCRIPTOR: descriptorPath, LEXIMEET_MCP_CLIENT: "cursor" },
  });
  const client = new Client({ name: "leximeet-install-smoke", version: "1.0.2" });
  await client.connect(transport);
  try {
    const listed = await client.listTools();
    if (listed.tools.length !== 4) throw new Error(`工具数量不是 4：${listed.tools.length}`);
    const stats = await client.callTool({
      name: "leximeet_query",
      arguments: { action: "get_learning_stats", args: {} },
    });
    if (stats.isError) throw new Error(`Core 健康/统计失败：${JSON.stringify(stats)}`);
    const lookup = await client.callTool({
      name: "leximeet_query",
      arguments: { action: "lookup_word", args: { word: "apple" } },
    });
    if (lookup.isError) throw new Error(`查词失败：${JSON.stringify(lookup)}`);
    return { tools: listed.tools.map((tool) => tool.name), stats, lookup };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const installer = process.env.LEXIMEET_INSTALLER;
  if (!installer || !path.isAbsolute(installer) || !fs.existsSync(installer))
    throw new Error("LEXIMEET_INSTALLER 必须是已下载安装包的绝对路径");
  const kind = kindOf(installer, process.env.LEXIMEET_INSTALL_KIND);
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-install-smoke-"));
  const installed = install(installer, kind);
  const childEnv = backgroundEnvironment({
    profileDir,
    seed: false,
    extraEnv: {
      HOME: profileDir,
      USERPROFILE: profileDir,
      APPDATA: path.join(profileDir, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(profileDir, "AppData", "Local"),
      LEXIMEET_MCP_WRITE_POINTER: "1",
    },
  });
  const child = spawn(installed.exe, installed.args || [], {
    env: childEnv,
    stdio: "ignore",
    windowsHide: true,
    detached: process.platform !== "win32",
  });
  let failed = "";
  try {
    const descriptor = await waitFor(
      () => {
        const file = path.join(profileDir, "mcp", "mcp-uds.json");
        return fs.existsSync(file) ? file : "";
      },
      90000,
      "Core / MCP 描述符",
    );
    const healthLog = path.join(profileDir, "logs");
    if (!fs.existsSync(healthLog)) fs.mkdirSync(healthLog, { recursive: true });
    const home = childEnv.HOME || childEnv.USERPROFILE || os.homedir();
    const launcher = mcpLauncherPath({ homeDir: home, env: childEnv });
    const resources = path.dirname(path.dirname(installed.exe));
    const shimCandidates = [
      path.join(path.dirname(installed.exe), "resources", "mcp-host", "host", "main.cjs"),
      path.join(resources, "resources", "mcp-host", "host", "main.cjs"),
      path.join(installed.exe, "..", "resources", "mcp-host", "host", "main.cjs"),
    ].map((file) => path.resolve(file));
    const shim = shimCandidates.find((file) => fs.existsSync(file));
    const command = fs.existsSync(launcher) ? launcher : installed.exe;
    const args = fs.existsSync(launcher) || !shim ? [] : [shim];
    const mcpEnv = { ...childEnv };
    if (!fs.existsSync(launcher) && shim) mcpEnv.ELECTRON_RUN_AS_NODE = "1";
    const result = await runMcp(descriptor, command, args, mcpEnv);
    console.log(JSON.stringify({ ok: true, kind, tools: result.tools, descriptor }, null, 2));
  } catch (error) {
    failed = error.message;
    throw error;
  } finally {
    if (child.pid) {
      try {
        signalTree(child.pid, "SIGKILL");
      } catch {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
      }
    }
    try {
      installed.uninstall();
    } catch (error) {
      if (!failed) throw error;
    }
    fs.rmSync(profileDir, { recursive: true, force: true });
  }
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main, kindOf };
