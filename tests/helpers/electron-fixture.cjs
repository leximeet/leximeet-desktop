const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { test: base, expect } = require("@playwright/test");
const { _electron } = require("playwright");
const { backgroundEnvironment } = require("./background-environment.cjs");
const { startFocusMonitor } = require("./macos-focus-monitor.cjs");
const { createBusinessClock } = require("./business-clock.cjs");

const root = path.resolve(__dirname, "../..");
const execFileAsync = promisify(execFile);

// 有界等待不占用事件循环；定时器会在任务提前完成时清理。
async function bounded(promise, milliseconds, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Playwright 在 POSIX 创建独立进程组；兜底仅结束本例启动的树，不按名称扫描用户进程。
async function forceOwnedProcess(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    await execFileAsync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      timeout: 10000,
      windowsHide: true,
    });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}

// 主进程已经退出时，POSIX 的进程组仍能标识本例遗留的 Java / renderer。
async function assertOwnedGroupExited(child) {
  if (process.platform === "win32" || !child?.pid) return;
  const deadline = Date.now() + 2000;
  while (true) {
    try {
      process.kill(-child.pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() >= deadline) {
      await forceOwnedProcess(child);
      throw new Error("Electron 退出后本例进程组仍有残留；已强制清理，生命周期验收失败。");
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

function requireExecutable(value, variable) {
  if (!value)
    throw new Error(`缺少 ${variable}；必须明确指定本平台应用的可执行文件，不能跳过验收。`);
  if (!path.isAbsolute(value)) throw new Error(`${variable} 必须使用绝对路径。`);
  const absolute = path.resolve(value);
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile())
    throw new Error(`${variable} 必须指向现有可执行文件，而不是目录：${absolute}`);
  fs.accessSync(absolute, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
  return fs.realpathSync(absolute);
}

/**
 * 每个用例持有一个 mkdtemp 根目录；同用例重启/升级可复用显式创建的 profile。
 * 不接受外部资料目录，失败时只附加日志与测试数据截图，不复制正式库或环境变量。
 */
function createDesktopFactory(testInfo) {
  const ownedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-playwright-"));
  const profiles = new Set();
  const sessions = [];
  let sequence = 0;
  function newProfile() {
    const profileDir = fs.mkdtempSync(path.join(ownedRoot, "profile-"));
    profiles.add(profileDir);
    return profileDir;
  }
  async function attachText(name, value) {
    await testInfo.attach(name, {
      body: Buffer.from(value),
      contentType: "text/plain",
    });
  }
  async function attachProfileLogs(profileDir, label) {
    const logDir = path.join(profileDir, "logs");
    if (!fs.existsSync(logDir)) return;
    for (const entry of fs.readdirSync(logDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.log(?:\.\d+)?$/.test(entry.name)) continue;
      const file = path.join(logDir, entry.name);
      // 只读取末尾 1 MiB，避免崩溃循环撑爆 CI artifact。
      const fd = fs.openSync(file, "r");
      try {
        const size = fs.fstatSync(fd).size;
        const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
        fs.readSync(fd, buffer, 0, buffer.length, Math.max(0, size - buffer.length));
        await attachText(`${label}-${entry.name}`, buffer.toString("utf8"));
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  async function start({
    executablePath,
    profileDir = newProfile(),
    seed = false,
    poisonHostJava = false,
    browserSandbox = false,
    extraEnv = {},
    skipSnapshot = false,
  } = {}) {
    if (!profiles.has(profileDir))
      throw new Error("测试只能使用 factory.newProfile() 创建的本例目录。");
    if (sessions.some((session) => session.profileDir === profileDir && !session.closed))
      throw new Error("同一 profile 必须先关闭旧实例，才能重启。");
    const label = `electron-${++sequence}`;
    const downloadsDir = path.join(profileDir, "downloads", label);
    fs.mkdirSync(downloadsDir, { recursive: true });
    const output = [];
    let outputLength = 0;
    const append = (origin, value) => {
      const line = `[${origin}] ${String(value).trimEnd()}\n`;
      output.push(line);
      outputLength += line.length;
      while (outputLength > 1024 * 1024 && output.length > 1) outputLength -= output.shift().length;
    };
    const env = backgroundEnvironment({
      profileDir,
      seed,
      browserSandbox,
      extraEnv,
    });
    // 正式包必须使用随包 Java。故意设置不存在的主机覆盖值，防止开发机恰好装 JDK 掩盖漏包。
    if (poisonHostJava) {
      env.JAVA_HOME = path.join(ownedRoot, "missing-host-java");
      env.LEXIMEET_JAVA = path.join(
        env.JAVA_HOME,
        "bin",
        process.platform === "win32" ? "java.exe" : "java",
      );
    }
    // 覆盖 Main 的 45s 冷启动期限和词典装配；不靠自动重试掩盖失败。
    const launchTimeout = Number(extraEnv.LEXIMEET_TEST_SEED_INDEX) > 0 ? 120000 : 60000;
    let app;
    let child;
    let session;
    let focusMonitor;
    try {
      // 外部只读监测先就绪，再启动应用；launch() 返回前的系统激活也会保留。
      focusMonitor = await startFocusMonitor({ root });
      app = await _electron.launch({
        ...(executablePath ? { executablePath } : {}),
        args: executablePath ? ["--env=prod"] : [root, "--env=prod"],
        cwd: root,
        env,
        timeout: launchTimeout,
      });
      child = app.process();
      focusMonitor.track(child.pid);
      // 所有自动化下载在点击业务按钮之前绑定到本例目录，禁止落入操作者的 Downloads。
      await app.evaluate(
        ({ session }, { dir, separator }) => {
          globalThis.__leximeetTestDownloads = [];
          session.defaultSession.on("will-download", (_event, item) => {
            const filename = item.getFilename().replace(/[\\/:*?"<>|]/g, "_");
            const target = `${dir}${separator}${filename}`;
            item.setSavePath(target);
            const record = { path: target, state: "started" };
            globalThis.__leximeetTestDownloads.push(record);
            item.once("done", (_event, state) => {
              record.state = state;
            });
          });
        },
        { dir: downloadsDir, separator: path.sep },
      );
      child.stdout?.on("data", (value) => append("stdout", value));
      child.stderr?.on("data", (value) => append("stderr", value));
      app.on("console", (message) => append(`main:${message.type()}`, message.text()));
      const pageErrors = [];
      const watchPage = (page) => {
        page.on("console", (message) => append(`renderer:${message.type()}`, message.text()));
        page.on("pageerror", (error) => {
          pageErrors.push(error.message);
          append("pageerror", error.stack || error.message);
        });
      };
      app.windows().forEach(watchPage);
      app.on("window", watchPage);
      session = {
        app,
        child,
        page: null,
        profileDir,
        downloadsDir,
        pageErrors,
        closed: false,
        label,
        tracing: false,
        focusMonitor,
      };
      // 启动尚未就绪时也必须能清理；先挂关闭入口，再登记本例会话。
      session.close = () => close(session);
      sessions.push(session);
      await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
      session.tracing = true;
      // 按业务页面识别主窗口；不把未来可能增加的启动屏误当作应用已经就绪。
      await expect
        .poll(
          () =>
            app
              .windows()
              .some((page) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(page.url())),
          { timeout: launchTimeout },
        )
        .toBe(true);
      const page = app
        .windows()
        .find((candidate) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(candidate.url()));
      session.page = page;
      session.mainWindowId = await app.evaluate(({ BrowserWindow }, url) => {
        const windows = BrowserWindow.getAllWindows().filter(
          (window) => window.webContents.getURL() === url,
        );
        if (windows.length !== 1) throw new Error("无法唯一绑定当前业务主窗口");
        return windows[0].id;
      }, page.url());
      page.setDefaultTimeout(15000);
      if (skipSnapshot) {
        await page.waitForFunction(
          async () => {
            try {
              return (await window.leximeet.runtime()).coreConnected === true;
            } catch {
              return false;
            }
          },
          null,
          { timeout: launchTimeout },
        );
      } else {
        await page.waitForFunction(
          async () => {
            try {
              return Array.isArray((await window.leximeet.snapshot()).words);
            } catch {
              return false;
            }
          },
          null,
          { timeout: launchTimeout },
        );
      }
      await page.locator(".connection-state").waitFor({ state: "hidden", timeout: launchTimeout });
      // 资料 HTTP 已可读与 Main 已完成词典装配是两个时刻，必须等原生运行时就绪。
      await expect
        .poll(
          () => page.evaluate(() => window.leximeet.runtime()).then((value) => value.coreConnected),
          { timeout: launchTimeout },
        )
        .toBe(true);
      const runtime = await page.evaluate(() => window.leximeet.runtime());
      expect(runtime.profile).toBe("test");
      expect(fs.realpathSync(runtime.dataDir)).toBe(fs.realpathSync(profileDir));
      expect(runtime.coreConnected).toBe(true);
      expect(
        await app.evaluate(() => globalThis.__leximeetTestBackground.snapshot()),
      ).toMatchObject({
        active: true,
        windowsCreated: 1,
        audioMuted: true,
        violations: [],
      });
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().map((win) => ({
            visible: win.isVisible(),
            focused: win.isFocused(),
            focusable: win.isFocusable(),
          })),
        ),
      ).toEqual([{ visible: false, focused: false, focusable: false }]);
      session.runtime = runtime;
      session.snapshot = () => page.evaluate(() => window.leximeet.snapshot());
      await attachText(
        `${label}-runtime.json`,
        JSON.stringify(
          {
            executablePath: executablePath || "source",
            version: await app.evaluate(({ app }) => app.getVersion()),
            profileDir,
            runtime,
          },
          null,
          2,
        ),
      );
      return session;
    } catch (error) {
      // launch() 自身失败时 Playwright 会结束它创建的进程树，并在异常内附带启动输出。
      append("startup-error", error.stack || error.message);
      if (session?.page && !session.page.isClosed()) {
        try {
          // 等待状态失败时保留当前原生运行状态，区别 Core 启动错误与仍在装配；不补成功或延长启动预算。
          const runtime = await bounded(
            session.page.evaluate(() => window.leximeet.runtime()),
            3000,
            "读取启动失败诊断超时",
          );
          await attachText(`${label}-startup-runtime.json`, JSON.stringify(runtime, null, 2));
        } catch (diagnosticError) {
          append("startup-diagnostic-error", diagnosticError.message);
        }
      }
      if (session)
        await close(session).catch((closeError) => append("close-error", closeError.message));
      else {
        if (app)
          await bounded(app.close(), 10000, "启动失败后的关闭超时").catch(() =>
            forceOwnedProcess(child),
          );
        if (focusMonitor) {
          const focus = await focusMonitor.stop();
          await attachText(
            `${label}-os-focus.json`,
            JSON.stringify({ ...focus, launchSucceeded: Boolean(child) }, null, 2),
          );
        }
        await attachProfileLogs(profileDir, label);
        await attachText(`${label}-startup.log`, output.join(""));
      }
      throw error;
    }
    async function close(target) {
      if (target.closed) return;
      target.closed = true;
      const errors = [];
      const record = async (operation) => {
        try {
          await operation();
        } catch (error) {
          errors.push(error);
        }
      };
      try {
        await record(async () => {
          const guard = await target.app.evaluate(() =>
            globalThis.__leximeetTestBackground.snapshot(),
          );
          await attachText(`${label}-window-guard.json`, JSON.stringify(guard, null, 2));
          expect(guard.violations, "从窗口创建起不应显示或聚焦任何测试窗口").toEqual([]);
          expect(
            await target.app.evaluate(({ BrowserWindow }) =>
              BrowserWindow.getAllWindows().every(
                (win) =>
                  !win.isVisible() &&
                  !win.isFocused() &&
                  !win.isFocusable() &&
                  win.webContents.isAudioMuted(),
              ),
            ),
          ).toBe(true);
        });
        if (target.page && !target.page.isClosed())
          await record(async () => {
            const screenshot = await target.page.screenshot({
              animations: "disabled",
              scale: "css",
              timeout: 5000,
            });
            await testInfo.attach(`${label}-window`, {
              body: screenshot,
              contentType: "image/png",
            });
          });
        if (target.tracing)
          await record(async () => {
            const trace = testInfo.outputPath(`${label}-trace.zip`);
            // 完整教学逐步保存明暗宽窄截图，trace 较大；给写出留出有界时间，不跳过诊断。
            await bounded(
              target.app.context().tracing.stop({ path: trace }),
              30000,
              "保存 Electron trace 超时",
            );
            await testInfo.attach(`${label}-trace`, {
              path: trace,
              contentType: "application/zip",
            });
          });
      } finally {
        await record(async () => {
          try {
            await bounded(target.app.close(), 10000, "Electron 正常退出超时");
          } catch (error) {
            await forceOwnedProcess(target.child);
            throw error;
          }
          await assertOwnedGroupExited(target.child);
        });
        // 包含退出与失败清理阶段；只报告本轮 PID 的违规，不记录操作者的应用名称。
        await record(async () => {
          const focus = await target.focusMonitor.stop();
          await attachText(
            `${label}-os-focus.json`,
            JSON.stringify({ ...focus, launchSucceeded: true }, null, 2),
          );
          if (focus.supported)
            expect(focus.complete, focus.error || "系统焦点监测应覆盖完整生命周期").toBe(true);
          expect(focus.violations, "测试应用或监测工具不能成为 macOS 前台应用").toEqual([]);
        });
        await record(() => attachProfileLogs(profileDir, label));
        await record(() => attachText(`${label}-console.log`, output.join("")));
      }
      if (errors.length) throw new AggregateError(errors, "Electron 清理/诊断失败");
      expect(target.pageErrors, "Renderer 不应出现未捕获异常").toEqual([]);
      const leftovers = fs.existsSync(path.join(profileDir, "core"))
        ? fs
            .readdirSync(path.join(profileDir, "core"))
            .filter((name) => name.startsWith("runtime-"))
        : [];
      expect(leftovers, "Java 退出后应清理它的运行副本").toEqual([]);
    }
  }
  async function stopAll() {
    const results = await Promise.allSettled(
      sessions.filter((session) => !session.closed).map((session) => session.close()),
    );
    const errors = results
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason);
    // 仅删除本 fixture 本次 mkdtemp 的根；保留诊断附件，绝不清理用户传入路径。
    fs.rmSync(ownedRoot, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 200,
    });
    if (errors.length) throw new AggregateError(errors, "测试实例清理失败");
  }
  function businessClock(profileDir, options) {
    if (!profiles.has(profileDir))
      throw new Error("业务时钟只能使用 factory.newProfile() 创建的本例目录。");
    return createBusinessClock(profileDir, options);
  }
  return { start, newProfile, businessClock, stopAll };
}

const test = base.extend({
  desktopFactory: async ({}, use, testInfo) => {
    const factory = createDesktopFactory(testInfo);
    try {
      await use(factory);
    } finally {
      await factory.stopAll();
    }
  },
  desktop: async ({ desktopFactory }, use) => {
    await use(await desktopFactory.start());
  },
});

// 捕获编辑器可保留为隐藏窗口；测试始终缩放绑定的业务主窗，并确认真实 renderer 已重排。
async function resizeDesktop(desktop, width, height) {
  const native = await desktop.app.evaluate(
    ({ BrowserWindow, screen }, target) => {
      const window = BrowserWindow.getAllWindows().find((item) => item.id === target.id);
      if (!window || window.isDestroyed()) throw new Error("绑定的业务主窗口不存在");
      window.setContentSize(target.width, target.height);
      return {
        content: window.getContentSize(),
        bounds: window.getBounds(),
        workArea: screen.getDisplayMatching(window.getBounds()).workArea,
      };
    },
    { id: desktop.mainWindowId, width, height },
  );
  await expect
    .poll(() => desktop.page.evaluate(() => [innerWidth, innerHeight]))
    .toEqual([width, height]);
  await desktop.page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  return { requested: { width, height }, native };
}
module.exports = { test, expect, root, requireExecutable, resizeDesktop };
