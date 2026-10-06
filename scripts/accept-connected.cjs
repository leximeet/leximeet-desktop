#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const readiness = require("./lib/connected-readiness.cjs");
const { connectedSessionRoot } = require("./lib/connected-session-path.cjs");
const { reclaimConnectedSession } = require("./lib/connected-session-cleanup.cjs");
const root = path.resolve(__dirname, "..");
const browserRoot = path.resolve(root, "../plugin/leximeet-browser");
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
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
const HELP = `词遇双端隔离人工验收（LMCP 1.0.0）

bash scripts/test-desktop.sh --connected [--check | --fresh] [--extension 构建目录]
bash scripts/test-desktop.sh --connected --cleanup 会话UUID

--check 只读核对 Browser 生产构建；不建资料、不注册、不下载、不启动窗口。
默认创建全新隔离空间，准备工具并构建随包 JRE 和外置 Native Host。
浏览器默认选中内置教学，另留 Node.js 英文文档；外网失败回本轮本地阅读页。
原独立资料只封存，不上传、不合并；配对必须由用户在真实界面确认。
终端 stop/restart 可测试同一资料断线恢复。Ctrl+C 退出本轮两个应用并回收大目录，保留小日志。
异常退出的环境保留供检查；--cleanup 只回收一个确认结束的会话，拒绝仍有进程或注册的环境。
启动和声明门禁不等于联合验收通过。当前本机 Native 注册仅完成 macOS。
`;

function writeRecord(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  fs.renameSync(temporary, file);
}

// 公共索引可能很大；逐块核对实际随包字节，避免把元数据声明当作使用证明。
async function fileSha256(file) {
  const hash = require("node:crypto").createHash("sha256");
  for await (const bytes of fs.createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

// 下载失败才依次尝试两套已约定代理；取消时立即停止，不切换成另一轮下载。
async function withDownloadFallback(run, { env = process.env, active = () => {} } = {}) {
  let lastFailure;
  for (const [attempt, port] of [null, 7897, 12334].entries()) {
    active();
    const downloadEnv = { ...env };
    for (const key of [
      "http_proxy",
      "https_proxy",
      "all_proxy",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "npm_config_proxy",
      "npm_config_https_proxy",
    ])
      delete downloadEnv[key];
    if (port) {
      const proxy = `http://127.0.0.1:${port}`;
      Object.assign(downloadEnv, {
        http_proxy: proxy,
        https_proxy: proxy,
        HTTP_PROXY: proxy,
        HTTPS_PROXY: proxy,
        all_proxy: `socks5://127.0.0.1:${port}`,
        ALL_PROXY: `socks5://127.0.0.1:${port}`,
        npm_config_proxy: proxy,
        npm_config_https_proxy: proxy,
      });
    }
    try {
      return await run({ attempt: attempt + 1, env: downloadEnv });
    } catch (error) {
      active();
      lastFailure = error;
    }
  }
  throw lastFailure;
}

// 文件属于已持有的 Main；只检查身份、权限和进程，不解析私有通道凭据。
async function waitDescriptor(
  profileRoot,
  child,
  { timeoutMs = 120000, now = Date.now, sleep = delay } = {},
) {
  const file = path.join(profileRoot, "native-messaging/lmcp-uds.json"),
    started = now();
  while (now() - started < timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError)
      throw new Error("Desktop 在本机通道就绪前退出；请查看本次 desktop.log");
    if (fs.existsSync(file)) {
      for (const [candidate, directory] of [
        [path.dirname(file), true],
        [file, false],
      ]) {
        const stat = fs.lstatSync(candidate);
        if (
          stat.isSymbolicLink() ||
          (directory ? !stat.isDirectory() : !stat.isFile()) ||
          stat.mode & 0o077 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())
        )
          throw new Error("Desktop 私有 descriptor 身份或权限不安全");
      }
      return file;
    }
    await sleep(Math.min(200, timeoutMs));
  }
  throw new Error("Desktop 本机通道未就绪；没有注册 Native Host");
}

// 只读取公开来源与实例身份；不访问、记录或转交 descriptor 中的私有 token。
function descriptorProjection(profileRoot, child, readDescriptor) {
  const read =
      readDescriptor || require("../electron/services/lmcp/private-files.cjs").readPrivateJson,
    descriptor = read(path.join(profileRoot, "native-messaging/lmcp-uds.json"));
  const { instanceId, pid, allowedOrigins } = descriptor;
  if (
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(instanceId || "") ||
    pid !== child.pid ||
    !Array.isArray(allowedOrigins)
  )
    throw new Error("Desktop 通道投影不是本轮实例");
  return { instanceId, allowedOrigins };
}

// 外部登记需经 Main 校验后才交付。必须是本轮实际来源和同一实例，非任意非空名单。
async function waitRegisteredOrigin(
  profileRoot,
  child,
  extensionId,
  instanceId,
  { timeoutMs = 15000, now = Date.now, sleep = delay, active = () => {}, readDescriptor } = {},
) {
  if (!/^[a-p]{32}$/.test(extensionId || "")) throw new Error("本轮实际插件 ID 无效");
  const extensionOrigin = `chrome-extension://${extensionId}/`,
    deadline = now() + timeoutMs;
  while (now() < deadline) {
    active();
    if (child.exitCode !== null || child.signalCode !== null || child.spawnError)
      throw new Error("Desktop 在来源登记就绪前退出");
    const projection = descriptorProjection(profileRoot, child, readDescriptor);
    if (projection.instanceId !== instanceId) throw new Error("Desktop 通道实例在来源登记期间变化");
    if (projection.allowedOrigins.includes(extensionOrigin))
      return { instanceId, extensionOrigin, ready: true };
    await sleep(Math.max(1, Math.min(100, deadline - now())));
  }
  throw new Error("本轮插件来源尚未被 Desktop 校验，不能交付连接环境");
}

// 同一截止时间内核验 Core、实际角色与可交互教学卡；DOM 存在不等于可访问。
async function waitDesktopRendered(
  page,
  {
    timeoutMs = 60000,
    now = Date.now,
    deadline = now() + timeoutMs,
    sleep = delay,
    active = () => {},
    singleCheck = false,
  } = {},
) {
  while (now() < deadline) {
    active();
    const snapshot = await page.evaluate(async () => {
      const runtime = await window.leximeet.runtime();
      if (!runtime.coreConnected || !document.querySelector(".status-state i.ready"))
        return { pending: true };
      const state = await window.leximeet.desktopState();
      return { guide: state?.guide };
    });
    if (!snapshot?.pending) {
      const guide = snapshot?.guide;
      if (!guide || typeof guide !== "object")
        throw new Error("Desktop 资料快照不完整，不能宣称界面就绪");
      const main = page.locator(".d-main .d-page").first();
      let ready = (await main.count()) === 1 && (await main.isVisible());
      const activeGuide = guide.active && !guide.finishedAt;
      if (ready && activeGuide) {
        const card = guide.started
          ? page.locator('.guide-coach[role="dialog"]')
          : page.getByRole("dialog", {
              name: "欢迎使用词遇",
              exact: true,
            });
        ready =
          (await card.count()) === 1 &&
          (await card.isVisible()) &&
          !(await card.evaluate((node) => Boolean(node.closest('[inert], [aria-hidden="true"]'))));
        if (ready) {
          const skip = card.getByRole("button", {
            name: "跳过教学",
            exact: true,
          });
          ready = (await skip.isVisible()) && (await skip.isEnabled());
        }
      } else if (ready)
        ready = (await page.locator(".guide-invitation, .guide-overlay").count()) === 0;
      if (ready)
        return {
          mainRendered: true,
          accessible: true,
          guide: activeGuide ? (guide.started ? "teaching" : "invitation") : "inactive",
        };
    }
    if (singleCheck) break;
    await sleep(Math.max(1, Math.min(100, deadline - now())));
  }
  throw new Error("Desktop 资料与可交互教学界面尚未就绪");
}

// 外站导航之后只做一次当前状态核验；不重开启动等待预算，也不代替用户处理教学。
async function verifyDesktopHandoff(page, options = {}) {
  return bounded(
    waitDesktopRendered(page, { ...options, singleCheck: true }),
    5000,
    "交付前 Desktop 状态读取超时，不能宣称双端已就绪",
  );
}

// 只记录和结束本轮 spawn 的进程组；不按进程名称搜索系统。
class OwnedProcesses {
  constructor({ record, save, kill = process.kill, sleep = delay }) {
    Object.assign(this, { record, save, kill, sleep });
    this.children = new Map();
    this.stopping = null;
  }
  add(name, child) {
    this.children.set(name, child);
    this.record.processes[name] = {
      pid: child.pid ?? null,
      startedAt: new Date().toISOString(),
    };
    child.on("error", (error) => {
      child.spawnError = error;
      this.record.processes[name].error = error.message;
      this.save();
    });
    child.on("exit", (code, signal) => {
      Object.assign(this.record.processes[name], {
        code,
        signal,
        exitedAt: new Date().toISOString(),
      });
      this.save();
    });
    this.save();
    return child;
  }
  alive(child) {
    return (
      Number.isInteger(child.pid) &&
      child.exitCode === null &&
      child.signalCode === null &&
      !child.spawnError
    );
  }
  signal(child, signal) {
    if (!this.alive(child) && !this.groupAlive(child)) return;
    try {
      this.kill(-child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  groupAlive(child) {
    if (!Number.isInteger(child.pid) || child.spawnError) return false;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  }
  async stopChild(child) {
    if (!this.alive(child) && !this.groupAlive(child)) return;
    this.signal(child, "SIGTERM");
    const deadline = Date.now() + 5000;
    while ((this.alive(child) || this.groupAlive(child)) && Date.now() < deadline)
      await this.sleep(100);
    if (this.alive(child) || this.groupAlive(child)) this.signal(child, "SIGKILL");
    if (this.alive(child)) await Promise.race([once(child, "exit"), this.sleep(2000)]);
    if (this.alive(child) || this.groupAlive(child))
      throw new Error("本轮持有的进程未能退出，保留失败记录");
  }
  stop(reason = "complete") {
    if (this.stopping) return this.stopping;
    this.stopping = (async () => {
      this.record.stopReason = reason;
      this.save();
      await Promise.all([...this.children.values()].map((child) => this.stopChild(child)));
      this.record.exitedAt = new Date().toISOString();
      this.save();
    })();
    return this.stopping;
  }
}

// 运行应用不继承宿主 JDK/Node 配置或云凭证；JRE 必须来自本次 app。
function cleanEnvironment(directory, { headless = true } = {}) {
  const inherited = require("../tests/helpers/background-environment.cjs").backgroundEnvironment({
    profileDir: directory,
    seed: false,
    browserSandbox: false,
  });
  delete inherited.JAVA_HOME;
  delete inherited.LEXIMEET_JAVA;
  inherited.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  if (!headless) {
    inherited.LEXIMEET_PROFILE = "demo";
    delete inherited.LEXIMEET_TEST_SILENT;
    delete inherited.LEXIMEET_TEST_BROWSER;
  }
  return inherited;
}

// 人工启动使用随包 app；自动测试调用同一入口时必须显式保持 headless。
async function startPackagedLab(
  checked,
  {
    headless = true,
    readingUrl,
    startupPage = headless ? "workspace" : "tutorial",
    navigationTimeout = 20000,
    outputDir,
    packageDirectory,
    prepare = true,
    poisonHostJava = false,
    signal,
    onStatus = console.log,
    beforeClose,
    onRecord = () => {},
  } = {},
) {
  if (process.platform !== "darwin")
    throw new Error("本轮 Native Host 仅完成 macOS；其他平台需独立验收");
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("请通过外层脚本准备 Node.js 24+");
  if (typeof headless !== "boolean") throw new Error("headless 必须是布尔值");
  if (!["tutorial", "workspace"].includes(startupPage))
    throw new Error("启动页只能是 tutorial 或 workspace");
  signal?.throwIfAborted();
  const id = randomUUID(),
    directory = path.join(connectedSessionRoot(), id);
  require("../electron/services/lmcp/private-files.cjs").ensurePrivateDirectory(
    connectedSessionRoot(),
  );
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  const logsDir = path.join(directory, "logs");
  fs.mkdirSync(logsDir, { mode: 0o700 });
  const profileRoot = path.join(directory, "desktop");
  fs.mkdirSync(profileRoot, { mode: 0o700 });
  const browserDataDir = path.join(profileRoot, "browser-profile/chrome");
  const extensionDir = path.join(directory, "browser-extension");
  const recordFile = path.join(directory, "acceptance.json");
  const record = {
    format: "leximeet.connected-acceptance/2",
    id,
    directory,
    profileRoot,
    browserDataDir,
    extensionDir,
    headless,
    startedAt: new Date().toISOString(),
    readiness: checked,
    processes: {},
    events: [],
    jointAcceptancePassed: false,
    cleanupErrors: [],
  };
  const save = () => {
    writeRecord(recordFile, record);
    if (outputDir) {
      fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
      writeRecord(path.join(outputDir, "acceptance.json"), record);
    }
    // CLI 父线程只保留退出恢复所需元信息，不转交资料内容或私有通道凭据。
    onRecord({
      directory,
      profileRoot,
      processes: record.processes,
      browser: record.browser,
    });
  };
  const owned = new OwnedProcesses({ record, save });
  save();
  const fds = [];
  let context,
    desktop,
    desktopPage,
    desktopChild,
    browserCdp,
    registration,
    focusMonitor,
    readingServer,
    workspace,
    reading,
    extensionId,
    closing,
    desktopReadinessDeadline,
    startingDesktop = false;
  let closeResolve, closeReject;
  const closed = new Promise((resolve, reject) => {
    closeResolve = resolve;
    closeReject = reject;
  });
  // 清理失败由显式 close()/closed 交付，不制造未处理 rejection。
  void closed.catch(() => {});
  let releaseStartup;
  const startupFinished = new Promise((resolve) => {
    releaseStartup = resolve;
  });
  const onAbort = () => {
    // 构建或启动尚在进行时也先结束已持有的组，再等待初始化交还清理权。
    for (const child of owned.children.values()) owned.signal(child, "SIGTERM");
    void close("cancelled").catch(() => {});
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const active = () => {
    signal?.throwIfAborted();
    if (closing)
      throw Object.assign(new Error("本轮环境正在退出"), {
        code: "LAB_CLOSING",
      });
  };
  async function command(name, executable, args, { cwd = root, env = process.env } = {}) {
    active();
    const child = owned.add(
      name,
      spawn(executable, args, { cwd, env, detached: true, stdio: "inherit" }),
    );
    const [code] = await once(child, "exit");
    active();
    if (code !== 0) throw new Error(`本轮 ${name} 准备失败 (${code})`);
  }
  async function until(check, timeoutMs, message) {
    const deadline = Date.now() + timeoutMs;
    do {
      active();
      if (await check()) return;
      await delay(100);
    } while (Date.now() < deadline);
    throw new Error(message);
  }
  let executable, hostScript, env;
  async function stopDesktop() {
    if (!desktop) return;
    const app = desktop,
      child = desktopChild;
    desktop = null;
    desktopPage = null;
    try {
      await bounded(app.close(), 15000, "本轮随包 Desktop 关闭超时");
    } finally {
      await owned.stopChild(child);
    }
  }
  async function stopBrowser() {
    if (!context) return;
    const browser = context;
    context = null;
    let closeFailure;
    try {
      await bounded(browser.close(), 15000, "本轮 Chromium 关闭超时");
    } catch (error) {
      closeFailure = error;
    }
    const pid = record.browser?.pid;
    const alive = () => {
      if (!Number.isInteger(pid)) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        if (error.code === "ESRCH") return false;
        throw error;
      }
    };
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await delay(100);
    if (alive()) {
      // PID 来自本轮创建的持久 Chromium CDP，不能按进程名称或日常 profile 清理。
      try {
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
      const forceDeadline = Date.now() + 2000;
      while (alive() && Date.now() < forceDeadline) await delay(100);
    }
    if (alive()) throw new Error("本轮 Chromium PID 仍存在，保留退出失败记录");
    if (closeFailure) throw closeFailure;
  }
  async function startDesktop() {
    active();
    if (desktop || startingDesktop) throw new Error("Desktop 已运行或正在启动");
    startingDesktop = true;
    try {
      const { _electron } = require("playwright");
      desktop = await _electron.launch({
        executablePath: executable,
        args: [],
        cwd: root,
        env,
        timeout: 60000,
      });
      desktopChild = owned.add(
        `desktop-${record.events.filter((event) => event.type === "desktop-start").length + 1}`,
        desktop.process(),
      );
      focusMonitor?.track(desktopChild.pid);
      active();
      const fd = fs.openSync(path.join(logsDir, "desktop.log"), "a", 0o600);
      fds.push(fd);
      for (const stream of [desktopChild.stdout, desktopChild.stderr])
        stream?.on("data", (bytes) => {
          if (fds.includes(fd)) fs.writeSync(fd, bytes);
        });
      await until(
        () =>
          desktop
            .windows()
            .some((page) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(page.url())),
        60000,
        "随包 Desktop 主页面未就绪",
      );
      desktopPage = desktop
        .windows()
        .find((page) => /\/frontend\/dist\/index\.html(?:$|[?#])/.test(page.url()));
      const application = await desktop.evaluate(({ app }) => ({
        packaged: app.isPackaged,
        resources: process.resourcesPath,
      }));
      if (!application.packaged) throw new Error("验收必须启动随包 app，不能降级到源码 Electron");
      // 两端启动与初次 UI 复核共用 60 秒；外站导航后另做一次最多 5 秒交付核验。
      desktopReadinessDeadline = Date.now() + 60000;
      record.desktopRendered = await waitDesktopRendered(desktopPage, {
        deadline: desktopReadinessDeadline,
        active,
      });
      const runtime = await desktopPage.evaluate(() => window.leximeet.runtime());
      if (
        fs.realpathSync(runtime.dataDir) !== fs.realpathSync(profileRoot) ||
        runtime.profile !== (headless ? "test" : "demo") ||
        runtime.connectorProtocolVersion !== `lmcp/${readiness.CONTRACT_VERSION}`
      )
        throw new Error("Desktop 实际运行资料或 LMCP 版本不符合本轮隔离约定");
      await waitDescriptor(profileRoot, desktopChild);
      record.desktopGateway = {
        instanceId: descriptorProjection(profileRoot, desktopChild).instanceId,
      };
      if (extensionId && registration)
        record.registrationReady = await waitRegisteredOrigin(
          profileRoot,
          desktopChild,
          extensionId,
          record.desktopGateway.instanceId,
          {
            timeoutMs: Math.max(1, desktopReadinessDeadline - Date.now()),
            active,
          },
        );
      const bundledJava = path.join(application.resources, "runtime/bin/java");
      const javaVersion = spawnSync(bundledJava, ["-version"], {
        encoding: "utf8",
        timeout: 5000,
        env,
      });
      if (javaVersion.status !== 0 || !/version "21[.\"]/.test(javaVersion.stderr || ""))
        throw new Error("随包 JRE 21 不能独立运行");
      record.application = {
        ...application,
        javaOverrideAbsent: !env.JAVA_HOME && !env.LEXIMEET_JAVA,
        hostJavaPoisoned: poisonHostJava,
        bundledJava,
        javaVersion: javaVersion.stderr.trim(),
      };
      record.desktopRuntime = {
        profile: runtime.profile,
        coreConnected: runtime.coreConnected,
        connectorProtocolVersion: runtime.connectorProtocolVersion,
      };
      if (headless) {
        const background = await desktop.evaluate(({ BrowserWindow }) => ({
          ...globalThis.__leximeetTestBackground.snapshot(),
          windows: BrowserWindow.getAllWindows().map((window) => ({
            visible: window.isVisible(),
            focused: window.isFocused(),
            focusable: window.isFocusable(),
          })),
        }));
        if (
          !background.active ||
          !background.audioMuted ||
          background.violations.length ||
          background.windows.some((window) => window.visible || window.focused || window.focusable)
        )
          throw new Error("后台随包应用可见、聚焦或保护未生效；不能继续自动化");
        record.background = background;
      }
      record.events.push({
        type: "desktop-start",
        at: new Date().toISOString(),
        pid: desktopChild.pid,
      });
      save();
      return desktopPage;
    } finally {
      startingDesktop = false;
    }
  }
  function assertBytes() {
    if (
      JSON.stringify(readiness.treeHashes(extensionDir)) !==
      JSON.stringify(checked.productionHashes)
    )
      throw new Error("本轮 Browser 生产副本字节发生变化");
    record.productionBytesUnchanged = true;
  }
  function close(reason = "complete") {
    if (closing) return closing;
    closing = (async () => {
      const errors = [],
        attempt = async (action) => {
          try {
            await action();
          } catch (error) {
            errors.push(error.message);
          }
        };
      await attempt(() => beforeClose?.());
      await startupFinished;
      await attempt(stopBrowser);
      await attempt(stopDesktop);
      await attempt(() => owned.stop(reason));
      if (registration)
        await attempt(async () =>
          require("../electron/services/lmcp/native-registration.cjs").unregisterNativeHost({
            ...registration,
            profileRoot,
          }),
        );
      await attempt(() => readingServer?.close());
      if (fs.existsSync(extensionDir)) await attempt(async () => assertBytes());
      if (focusMonitor)
        await attempt(async () => {
          record.focus = await focusMonitor.stop();
          if (!record.focus.complete || record.focus.violations.length)
            throw new Error("系统焦点监测不完整或本轮窗口曾激活");
        });
      for (const fd of fds.splice(0)) await attempt(async () => fs.closeSync(fd));
      record.cleanupErrors = errors;
      record.stoppedAt = new Date().toISOString();
      record.stopReason = reason;
      save();
      signal?.removeEventListener("abort", onAbort);
      if (errors.length)
        throw new AggregateError(
          errors.map((message) => new Error(message)),
          `本轮清理失败，保留隔离资料；检查后定向回收：node scripts/accept-connected.cjs --cleanup ${id}`,
        );
      if (record.error) {
        onStatus(
          `启动失败的环境已停止，保留诊断资料：${directory}\n检查后回收：node scripts/accept-connected.cjs --cleanup ${id}`,
        );
      } else {
        // 同一会话的 stop/restart 保留数据；仅最终关闭且全部进程、注册退出后回收自有副本。
        await attempt(async () => Object.assign(record, reclaimConnectedSession(id)));
        record.cleanupErrors = errors;
        save();
        if (errors.length) throw new Error(`隔离副本回收失败，保留记录：${errors.join("；")}`);
        onStatus(`双端隔离环境已退出，应用与资料副本已回收；日志和验收记录：${directory}`);
      }
    })();
    closing.then(closeResolve, closeReject);
    return closing;
  }
  try {
    if (prepare) {
      const toolInfo = path.join(directory, "environment.json");
      await command("prepare", process.execPath, [
        "-e",
        "require('./scripts/accept-desktop.cjs').prepare().then(value=>require('node:fs').writeFileSync(process.argv[1],JSON.stringify(value),{mode:0o600})).catch(error=>{console.error(error);process.exit(1)})",
        toolInfo,
      ]);
      record.environment = JSON.parse(fs.readFileSync(toolInfo, "utf8"));
      save();
      const buildEnv = {
        ...process.env,
        JAVA_HOME: record.environment.javaHome,
        LEXIMEET_JAVA: path.join(record.environment.javaHome, "bin/java"),
        LEXIMEET_MAVEN: record.environment.maven,
        PATH: [
          path.dirname(record.environment.node),
          path.dirname(record.environment.maven),
          path.join(record.environment.javaHome, "bin"),
          process.env.PATH,
        ].join(path.delimiter),
      };
      const npm = path.join(path.dirname(process.execPath), "npm");
      const lockSha = require("node:crypto")
        .createHash("sha256")
        .update(fs.readFileSync(path.join(browserRoot, "package-lock.json")))
        .digest("hex");
      const dependencyMarker = path.join(root, ".runtime/connected-browser-npm-ready.json");
      let installed;
      try {
        installed = JSON.parse(fs.readFileSync(dependencyMarker, "utf8"));
      } catch {
        // 首次安装。
      }
      if (
        !fs.existsSync(path.join(browserRoot, "node_modules/@playwright/test/package.json")) ||
        installed?.lockSha !== lockSha ||
        installed?.node !== process.versions.node
      ) {
        await withDownloadFallback(
          ({ attempt, env: downloadEnv }) =>
            command(`browser-dependencies-${attempt}`, npm, ["ci", "--no-audit", "--no-fund"], {
              cwd: browserRoot,
              env: downloadEnv,
            }),
          {
            active,
            env: {
              ...buildEnv,
              npm_config_cache: path.join(root, ".runtime/npm-cache"),
            },
          },
        );
        writeRecord(dependencyMarker, { lockSha, node: process.versions.node });
      }
      await command("browser-build", npm, ["run", "build"], {
        cwd: browserRoot,
        env: buildEnv,
      });
      await command("browser-manifest", npm, ["run", "verify:manifest"], {
        cwd: browserRoot,
        env: buildEnv,
      });
      // 两项目各自构建，不改 Browser 源码、manifest 权限或生产 bundle。
      checked = readiness.checkReadiness(checked.extensionDir);
      record.readiness = checked;
      packageDirectory = path.join(directory, "application");
      await command("package", process.execPath, [path.join(__dirname, "package.cjs"), "dir"], {
        env: {
          ...buildEnv,
          LEXIMEET_BUILD_OUTPUT: packageDirectory,
          LEXIMEET_ACCEPTANCE_APP: "1",
        },
      });
    }
    if (!packageDirectory) throw new Error("随包验收缺少本轮 app 构建目录");
    const applications = path.join(
      packageDirectory,
      process.arch === "arm64" ? "mac-arm64" : "mac",
    );
    const names = ["LexiMeet.app", "LexiMeet Acceptance.app"].filter((name) =>
      fs.existsSync(path.join(applications, name)),
    );
    if (names.length !== 1) throw new Error("候选目录必须恰有一个本轮正式或验收应用");
    const application = path.join(applications, names[0]);
    executable = path.join(application, "Contents/MacOS", names[0].slice(0, -4));
    hostScript = path.join(application, "Contents/Resources/native-host/host/main.cjs");
    for (const file of [
      executable,
      hostScript,
      path.join(application, "Contents/Resources/runtime/bin/java"),
    ])
      if (!fs.statSync(file).isFile())
        throw new Error("本轮验收 app、随包 JRE 或外置 Native Host 缺失");
    record.packagedArtifacts = {
      // 正常退出会删除本轮 app；摘要必须在实际文件仍存在时计算，供验收记录复核。
      appAsarSha256: await fileSha256(path.join(application, "Contents/Resources/app.asar")),
      nativeHostFiles: readiness.treeHashes(
        path.join(application, "Contents/Resources/native-host"),
      ),
      coreJarSha256: require("node:crypto")
        .createHash("sha256")
        .update(
          fs.readFileSync(path.join(application, "Contents/Resources/core/leximeet-core.jar")),
        )
        .digest("hex"),
    };
    const dictionaryIndex = path.join(
        application,
        "Contents/Resources/dictionary/core-text.sqlite",
      ),
      dictionaryMetadata = `${dictionaryIndex}.json`,
      indexMetadata = JSON.parse(fs.readFileSync(dictionaryMetadata, "utf8")),
      indexSha256 = await fileSha256(dictionaryIndex);
    if (indexSha256 !== indexMetadata.indexSha)
      throw new Error("实际随包公共索引与元数据摘要不一致");
    record.packagedArtifacts.dictionaryIndex = {
      version: indexMetadata.version,
      edition: indexMetadata.edition,
      indexVersion: indexMetadata.indexVersion,
      entryCount: indexMetadata.entryCount,
      indexBytes: fs.statSync(dictionaryIndex).size,
      indexSha256,
      metadataSha256: await fileSha256(dictionaryMetadata),
    };
    const current = readiness.checkReadiness(checked.extensionDir);
    if (JSON.stringify(current.productionHashes) !== JSON.stringify(checked.productionHashes))
      throw new Error("准备期间 Browser 构建变化，请重新启动");
    fs.cpSync(checked.extensionDir, extensionDir, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    assertBytes();
    env = cleanEnvironment(profileRoot, { headless });
    // 只在包级自动断言启用：不可用宿主 Java 不能被错误选中，也不允许源码降级。
    if (poisonHostJava) {
      env.JAVA_HOME = path.join(directory, "unavailable-host-jdk");
      env.LEXIMEET_JAVA = path.join(env.JAVA_HOME, "bin/java");
    }
    const { chromium } = require("playwright");
    if (!fs.existsSync(chromium.executablePath())) {
      if (!prepare) throw new Error("缺少 Playwright Chromium；测试不得临时换成日常浏览器");
      await withDownloadFallback(
        ({ attempt, env: downloadEnv }) =>
          command(
            `chromium-${attempt}`,
            process.execPath,
            [require.resolve("playwright/cli"), "install", "chromium"],
            { env: downloadEnv },
          ),
        { active },
      );
    }
    // 复用插件项目的隔离阅读页与终端交互；源码自动联调继续运行其原始 driver。
    const browserHelpers = await import(
      pathToFileURL(path.join(browserRoot, "scripts/lib/connected-lab-reading.mjs")).href
    );
    const startupPages = await import(
      pathToFileURL(path.join(browserRoot, "scripts/lib/lab-startup-pages.mjs")).href
    );
    readingUrl = startupPages.labReadingUrl({ headless, readingUrl });
    if (headless)
      focusMonitor = await require("../tests/helpers/macos-focus-monitor.cjs").startFocusMonitor({
        root,
      });
    active();
    readingServer = await browserHelpers.startConnectedReadingServer();
    await startDesktop();
    fs.mkdirSync(browserDataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(browserDataDir, 0o700);
    process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
    // 仅人工外站文档复用 Browser 的项目代理；自动 fixture 直连，不探测外网。
    const proxy =
      !headless && readingUrl !== "local"
        ? await (
            await import(pathToFileURL(path.join(browserRoot, "scripts/lab-network.mjs")).href)
          ).labProxy()
        : undefined;
    if (proxy) onStatus("本轮隔离 Chromium 已启用代理，回环阅读页仍直连。");
    context = await chromium.launchPersistentContext(browserDataDir, {
      ...(proxy ? { proxy } : {}),
      channel: "chromium",
      headless,
      viewport: null,
      locale: "zh-CN",
      timezoneId: "Asia/Shanghai",
      env,
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      args: [
        `--disable-extensions-except=${extensionDir}`,
        `--load-extension=${extensionDir}`,
        "--enable-unsafe-extension-debugging",
        "--window-size=1440,1000",
        "--no-first-run",
        "--disable-sync",
        "--disable-background-networking",
      ],
    });
    active();
    browserCdp = await context.browser().newBrowserCDPSession();
    const version = await browserCdp.send("Browser.getVersion");
    if (version.userAgent.includes("HeadlessChrome/") !== headless)
      throw new Error("Chromium 实际运行方式与本轮要求不一致");
    const browserPid = (await browserCdp.send("SystemInfo.getProcessInfo")).processInfo.find(
      (item) => item.type === "browser",
    )?.id;
    if (!browserPid) throw new Error("无法观察本輪独立 Chromium PID");
    focusMonitor?.track(browserPid);
    record.browser = { pid: browserPid, product: version.product };
    save();
    const worker =
      context.serviceWorkers().find((page) => page.url().startsWith("chrome-extension://")) ||
      (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    await until(
      () => worker.evaluate(() => chrome.action.onClicked.hasListeners()),
      15000,
      "生产扩展后台未就绪",
    );
    extensionId = new URL(worker.url()).hostname;
    if (
      !/^[a-p]{32}$/.test(extensionId) ||
      (checked.extensionId && checked.extensionId !== extensionId)
    )
      throw new Error("实际扩展 ID 不符合本轮生产副本");
    record.extensionId = extensionId;
    registration = require("./lmcp/register-host.cjs").registerIsolatedHost({
      profileRoot,
      browserDataDir,
      extensionId,
      electronExecutable: executable,
      hostScript,
    });
    record.registration = {
      isolated: registration.isolated,
      hostName: registration.hostName,
      manifestPath: registration.manifestPath,
    };
    record.registrationReady = await waitRegisteredOrigin(
      profileRoot,
      desktopChild,
      extensionId,
      record.desktopGateway.instanceId,
      {
        timeoutMs: Math.max(1, desktopReadinessDeadline - Date.now()),
        active,
      },
    );
    const tutorial = await startupPages.installedTutorial({ context, extensionId, signal });
    for (const page of context.pages()) if (page.url() === "about:blank") await page.close();
    workspace = await context.newPage();
    await workspace.goto(`chrome-extension://${extensionId}/${checked.optionsPage}#/settings`);
    // 两端都已启动后再观察真实 UI，避免把尚未可交互的邀请卡交给用户。
    record.desktopRendered = await waitDesktopRendered(desktopPage, {
      deadline: desktopReadinessDeadline,
      active,
    });
    const finalRuntime = await desktopPage.evaluate(() => window.leximeet.runtime());
    record.desktopRuntime = {
      profile: finalRuntime.profile,
      coreConnected: finalRuntime.coreConnected,
      connectorProtocolVersion: finalRuntime.connectorProtocolVersion,
    };
    // 外站导航不参与 Desktop 就绪预算；它失败时只替换阅读标签。
    const opened = await startupPages.openLabReadingPage({
      context,
      readingUrl,
      localUrl: readingServer.localUrl,
      navigationTimeout,
      signal,
      onStatus,
    });
    reading = opened.reading;
    record.requestedReadingUrl = opened.requestedUrl;
    record.readingUrl = opened.url;
    record.readingFallback = opened.fallback;
    record.localUrl = readingServer.localUrl;
    record.readingNavigationCompletedAt = new Date().toISOString();
    // Desktop 启动可能晚于教学页；全部就绪后最后选中教学，避免管理标签盖住它。
    record.startupUrl = await startupPages.activateLabPage({ tutorial, workspace, startupPage });
    record.desktopHandoffRendered = await verifyDesktopHandoff(desktopPage, { active });
    record.desktopHandoffVerifiedAt = new Date().toISOString();
    context.once("close", () => {
      void close("browser-closed").catch(() => {});
    });
    save();
    releaseStartup();
    onStatus(
      `已启动双端隔离验收：${id}\n运行方式：${headless ? "无界面自动化" : "可见人工验收"}\n资料：${directory}\n记录：${recordFile}\n插件 ID：${extensionId}\n阅读页：${record.readingUrl}\n使用教学：${tutorial.url()}\n在任一端选择一键连接，在浏览器的独立弹窗确认；配对认证由后台自动完成。原独立资料封存，不上传、不合并。\nCtrl+C 结束本轮环境；终端 stop/restart 测试同一资料的断线恢复。`,
    );
    return {
      id,
      directory,
      profileRoot,
      extensionId,
      record,
      saveEvidence: save,
      closed,
      close,
      get desktop() {
        return desktop;
      },
      get desktopPage() {
        return desktopPage;
      },
      context,
      workspace,
      reading,
      stopDesktop,
      restartDesktop: startDesktop,
      async openPanel(page = reading) {
        await page.bringToFront();
        const targets = (
          await browserCdp.send("Target.getTargets", {
            filter: [{ type: "tab", exclude: false }],
          })
        ).targetInfos.filter((target) => target.url === page.url());
        if (targets.length !== 1) throw new Error("侧栏动作必须对应本轮唯一阅读标签");
        await browserCdp.send("Extensions.triggerAction", {
          id: extensionId,
          targetId: targets[0].targetId,
        });
        const panelUrl = `chrome-extension://${extensionId}/${checked.panelPage}`;
        await until(
          () => context.pages().some((candidate) => candidate.url() === panelUrl),
          15000,
          "真实原生侧栏未打开",
        );
        const panel = context.pages().find((candidate) => candidate.url() === panelUrl);
        const contexts = await panel.evaluate(() =>
          chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] }),
        );
        if (!contexts.some((item) => item.documentUrl === panelUrl))
          throw new Error("不能用普通标签替代原生 SIDE_PANEL");
        record.nativePanel = true;
        save();
        return panel;
      },
    };
  } catch (error) {
    record.error = error.message;
    save();
    releaseStartup();
    await close("startup-error");
    throw error;
  }
}

async function start(checked) {
  const controller = new AbortController();
  let session, commands;
  const stop = (name) => {
    process.exitCode = name === "SIGINT" ? 130 : 143;
    controller.abort(new Error("本轮验收已取消"));
  };
  const onInt = () => stop("SIGINT"),
    onTerm = () => stop("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  try {
    // Playwright Electron 自带进程级 SIGINT 退出；放在 Worker，主线程才能等到完整清理结束。
    session = require("./lib/connected-cli-worker.cjs").createCliSession(checked, {
      signal: controller.signal,
      onStatus: console.log,
    });
    await session.ready;
    const { installManualDesktopCommands } = await import(
      pathToFileURL(path.join(browserRoot, "scripts/lib/connected-lab-terminal.mjs")).href
    );
    commands = installManualDesktopCommands({
      session,
      headless: false,
      signal: controller.signal,
      onInterrupt: onInt,
    });
    await session.closed;
  } catch (error) {
    if (error !== controller.signal.reason) throw error;
  } finally {
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    try {
      await commands?.close();
    } finally {
      await session?.close();
    }
  }
}
async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = readiness.parseArguments(argv);
  if (options.mode === "help") {
    console.log(HELP);
    return { help: true };
  }
  if (options.mode === "cleanup") {
    const reclaimed = (dependencies.reclaimConnectedSession || reclaimConnectedSession)(
      options.sessionId,
    );
    console.log(
      `已回收会话 ${options.sessionId} 的应用与资料副本；日志保留：${reclaimed.directory}`,
    );
    return reclaimed;
  }
  if (options.mode === "check") {
    const checked = (dependencies.checkReadiness || readiness.checkReadiness)(options.extensionDir);
    console.log(
      JSON.stringify(
        {
          ...checked,
          productionHashes: undefined,
          fileCount: Object.keys(checked.productionHashes).length,
        },
        null,
        2,
      ),
    );
    console.log("仅生产构建声明和字节门禁通过，未启动、注册或验证连接行为。");
    return checked;
  }
  // 正常入口先由隔离构建流程准备当前两端，再读取新生产包；首次没有 .output 也可一键启动。
  return (dependencies.start || start)({ extensionDir: options.extensionDir });
}
module.exports = {
  main,
  startPackagedLab,
  waitDescriptor,
  waitDesktopRendered,
  verifyDesktopHandoff,
  waitRegisteredOrigin,
  OwnedProcesses,
  cleanEnvironment,
  withDownloadFallback,
};
if (require.main === module)
  main().catch((error) => {
    console.error(`双端验收未启动 / 已停止：${error.message}`);
    process.exitCode = 1;
  });
