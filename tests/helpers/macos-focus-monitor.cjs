"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn, execFile } = require("node:child_process");
const { promisify } = require("node:util");
const readline = require("node:readline");

// 先观察再登记 PID，保留 launch() 返回前的激活；用户正常切换应用不算违规。
class FocusEvidence {
  constructor() {
    this.events = [];
    this.pids = new Set();
    this.startedAt = Date.now();
  }
  track(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new Error("监测必须登记有效的测试 PID");
    this.pids.add(pid);
  }
  observe(event) {
    if (
      !["activation", "sample"].includes(event.type) ||
      !Number.isInteger(event.pid) ||
      event.pid <= 0 ||
      !Number.isFinite(event.at)
    )
      throw new Error("macOS 焦点监测收到无效事件");
    if (this.events.length >= 4096) throw new Error("macOS 焦点记录超出有界预算");
    // 只存 PID / 进程组 / 时刻；原生输入里的其他内容不进入证据。
    this.events.push({
      type: event.type,
      pid: event.pid,
      group: event.group,
      at: event.at,
    });
  }
  report(complete) {
    return {
      platform: "darwin",
      supported: true,
      complete,
      startedAt: this.startedAt,
      stoppedAt: Date.now(),
      trackedPids: [...this.pids],
      observationCount: this.events.length,
      violations: this.events.filter(
        (event) => this.pids.has(event.pid) || this.pids.has(event.group),
      ),
    };
  }
}

// 编译缓存只写项目 .runtime；缺少 Command Line Tools 时在启动 Electron 前明确失败。
async function prepareFocusObserver(root) {
  const source = path.join(__dirname, "macos-focus-observer.swift");
  const hash = createHash("sha256")
    .update(fs.readFileSync(source))
    .update(process.arch)
    .digest("hex")
    .slice(0, 20);
  const directory = path.join(root, ".runtime/test-tools", hash);
  const executable = path.join(directory, "focus-observer");
  if (!fs.existsSync(executable)) {
    fs.mkdirSync(directory, { recursive: true });
    const temporary = `${executable}.${process.pid}`;
    try {
      await promisify(execFile)(
        "/usr/bin/xcrun",
        [
          "swiftc",
          source,
          "-O",
          "-o",
          temporary,
          "-module-cache-path",
          path.join(root, ".runtime/test-tools/swift-module-cache"),
        ],
        { timeout: 90000, maxBuffer: 256 * 1024 },
      );
      fs.renameSync(temporary, executable);
    } catch (error) {
      fs.rmSync(temporary, { force: true });
      throw new Error(
        `无法准备 macOS 只读焦点监测。请安装 Xcode Command Line Tools；未启动测试应用。${error.message}`,
      );
    }
  }
  return executable;
}

function timeout(promise, milliseconds, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function startFocusMonitor({
  root,
  platform = process.platform,
  executable,
  spawnProcess = spawn,
}) {
  if (platform !== "darwin")
    return {
      track() {},
      stop: async () => ({
        platform,
        supported: false,
        complete: false,
        reason: "当前平台未实现系统前台应用监测；仍检查隐藏窗口。",
        violations: [],
      }),
    };
  const child = spawnProcess(executable || (await prepareFocusObserver(root)), [], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const evidence = new FocusEvidence();
  let ready = false,
    finished = false,
    failure,
    stderr = "",
    stopPromise;
  let resolveReady, rejectReady;
  const readiness = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // 退出 Promise 不提前 reject，避免编译/启动错误产生未处理 rejection。
  let closed = false;
  // close 在 stdout 排空后到达；exit 可能早于最后一条 finished，并且启动失败不一定有 exit。
  const exit = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      closed = true;
      resolve({ code, signal });
    }),
  );
  const fail = (error) => {
    failure ||= error;
    if (!ready) rejectReady(error);
  };
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (value) => {
    stderr = (stderr + value).slice(-8192);
  });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("error", fail);
  lines.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "ready") {
        if (ready || event.observable !== true)
          throw new Error("macOS 前台应用不可观测；未启动测试应用。");
        evidence.track(event.pid); // 监测工具自身也不能变成前台应用。
        ready = true;
        resolveReady();
      } else if (event.type === "finished") finished = true;
      else evidence.observe(event);
    } catch (error) {
      fail(error);
    }
  });
  child.once("close", (code) => {
    if (!finished || code !== 0) fail(new Error(`macOS 焦点监测意外退出：${code ?? "signal"}`));
  });
  async function stop() {
    if (!stopPromise)
      stopPromise = (async () => {
        let result;
        try {
          if (!closed) child.stdin.end("stop\n");
          result = await timeout(exit, 5000, "macOS 焦点监测退出超时");
        } catch (error) {
          fail(error);
          child.kill("SIGKILL");
          await timeout(exit, 5000, "macOS 焦点监测强制退出超时");
        } finally {
          lines.close();
        }
        const report = evidence.report(ready && finished && result?.code === 0 && !failure);
        if (failure) report.error = failure.message;
        if (stderr) report.diagnostic = stderr;
        return report;
      })();
    return stopPromise;
  }
  try {
    await timeout(readiness, 10000, "macOS 焦点监测启动超时；未启动测试应用。");
  } catch (error) {
    await stop();
    throw error;
  }
  return { track: (pid) => evidence.track(pid), stop };
}

module.exports = { FocusEvidence, prepareFocusObserver, startFocusMonitor };
