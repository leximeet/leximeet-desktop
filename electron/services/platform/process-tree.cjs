"use strict";
const { execFileSync } = require("node:child_process");
const { runPowerShell } = require("./powershell.cjs");
const { powershellQuote } = require("./shell-quote.cjs");
const { windowsSystem32Binary } = require("./identity.cjs");

function parsePids(text) {
  return String(text || "")
    .split(/[\s,;]+/)
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 1);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    return true;
  }
}

function posixDirectChildren(pid) {
  try {
    const output = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
    return parsePids(output);
  } catch (error) {
    if (error.status === 1 || error.code === "ENOENT") return [];
    throw error;
  }
}

function windowsDirectChildren(pid) {
  const filter = `ParentProcessId=${pid}`;
  const script = `(Get-CimInstance -ClassName Win32_Process -Filter ${powershellQuote(filter)}).ProcessId`;
  try {
    return parsePids(runPowerShell(script));
  } catch {
    return [];
  }
}

function directChildren(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return [];
  return process.platform === "win32" ? windowsDirectChildren(pid) : posixDirectChildren(pid);
}

function listDescendants(pid) {
  const found = [];
  const seen = new Set([pid]);
  const queue = [pid];
  while (queue.length) {
    const current = queue.shift();
    for (const child of directChildren(current)) {
      if (seen.has(child)) continue;
      seen.add(child);
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

function linuxGroupAlive(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM") return true;
    throw error;
  }
}

function treeAlive(pid) {
  if (pidAlive(pid)) return true;
  if (process.platform === "linux" && linuxGroupAlive(pid)) return true;
  return listDescendants(pid).some(pidAlive);
}

function posixSignal(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
  }
}

function windowsTaskkill(pid, force) {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const args = ["/PID", String(pid), "/T"];
  if (force) args.push("/F");
  try {
    execFileSync(windowsSystem32Binary("taskkill.exe"), args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
  } catch (error) {
    if (pidAlive(pid) && force) throw new Error(`taskkill 未能结束进程树 ${pid}：${error.message}`);
  }
}

/** Windows 上 Node 跟踪的 PID 可能不是真正持锁的 JVM；只匹配本实例资料目录的命令行。 */
function windowsCommandLineQuery(needle) {
  return [
    `$n = ${powershellQuote(String(needle))}`,
    // 先按映像名缩小，避免全量 CIM 把 java 的 CommandLine 读丢或超时。
    `$procs = Get-CimInstance -ClassName Win32_Process -Filter "Name='java.exe' OR Name='javaw.exe' OR Name='node.exe'"`,
    `$procs | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($n) } | ForEach-Object { $_.ProcessId }`,
  ].join("; ");
}

function listPidsByCommandLine(needle) {
  if (process.platform !== "win32" || !needle) return [];
  try {
    const output = runPowerShell(windowsCommandLineQuery(needle));
    return parsePids(output).filter((pid) => pid !== process.pid);
  } catch {
    return [];
  }
}

function signalOwnedByMarker(marker) {
  if (process.platform !== "win32" || !marker) return;
  for (const pid of listPidsByCommandLine(marker)) windowsTaskkill(pid, true);
}

/**
 * 结束本轮持有的进程树：Linux 用进程组，Windows 用 taskkill /T，macOS 按 PID 与子进程。
 * 不按进程名称搜索，也不向其他用户的进程发信号。
 */
function signalTree(pid, signal = "SIGTERM") {
  if (!Number.isInteger(pid) || pid <= 1) return;
  const descendants = listDescendants(pid);
  if (process.platform === "win32") {
    windowsTaskkill(pid, true);
    for (const child of descendants) {
      if (pidAlive(child)) windowsTaskkill(child, true);
    }
    return;
  }
  if (process.platform === "linux") posixSignal(-pid, signal);
  for (const target of [pid, ...descendants]) posixSignal(target, signal);
}

module.exports = {
  pidAlive,
  treeAlive,
  listDescendants,
  signalTree,
  listPidsByCommandLine,
  signalOwnedByMarker,
  windowsCommandLineQuery,
};
