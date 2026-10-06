"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { pathToFileURL } = require("node:url");
const { createBridge, METHODS } = require("../../electron/services/bridge.cjs");
const { DeveloperMonitor } = require("../../electron/services/developer-monitor.cjs");
const { DesktopController } = require("../../electron/services/desktop-controller.cjs");
const { businessClock } = require("../../electron/services/business-clock.cjs");

const projectDir = path.resolve(__dirname, "../..");
const mainPath = path.join(projectDir, "electron/main.js");
const initialSettings = () => ({
  closeBehavior: "platform",
  launchAtLogin: false,
  developerMonitoringEnabled: false,
});
const flush = () => new Promise(setImmediate);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/**
 * 执行生产 main.js，只替换外部副作用；不复制其启动/退出逻辑。
 * Windows 平台替身用于验证退出后不能新建托盘，不依赖宿主操作系统。
 * 所有路径仅供返回和比对，不创建目录；没有真实 Electron、子进程或系统登录项。
 */
function mainFixture(t, options = {}) {
  const profile = {
    name: "test",
    root: "/in-memory/leximeet",
    coreDir: "/in-memory/leximeet/core",
    sessionDir: "/in-memory/leximeet/session",
  };
  const handlers = new Map(),
    eggEvents = new Map(),
    trays = new Set();
  const calls = {
    starts: 0,
    stops: 0,
    requests: [],
    quitCompleted: 0,
    traysCreated: 0,
    gatewayStarts: 0,
    gatewayStops: 0,
  };
  let core, monitor, desktop;
  class Core {
    constructor() {
      core = this;
      this.state = "stopped";
      this.port = null;
      this.lastError = null;
    }
    async start() {
      const attempt = ++calls.starts;
      this.state = "starting";
      try {
        await options.start?.(attempt);
        this.state = "ready";
        this.port = 43123;
        return this;
      } catch (error) {
        this.state = "failed";
        this.lastError = error.message;
        throw error;
      }
    }
    async stop() {
      this.state = "stopped";
      this.port = null;
      calls.stops++;
      await options.stop?.(calls.stops);
    }
    async request(route, method, body) {
      calls.requests.push({ route, method, body });
      if (options.request) return options.request(route, method, body);
      if (route === "/api/snapshot" || route === "/api/settings")
        return { words: [], settings: initialSettings() };
      throw new Error(`测试未定义 Core 请求：${route}`);
    }
  }
  class Monitor extends DeveloperMonitor {
    constructor(args) {
      super(args);
      monitor = this;
    }
  }
  class Desktop extends DesktopController {
    constructor(args) {
      super({ ...args, platform: "win32" });
      desktop = this;
    }
  }
  class Tray extends EventEmitter {
    constructor() {
      super();
      trays.add(this);
      calls.traysCreated++;
    }
    setToolTip() {}
    setContextMenu() {}
    destroy() {
      trays.delete(this);
    }
  }
  class Egg {
    register(name, callback) {
      eggEvents.set(name, callback);
    }
    run() {}
  }
  const app = new EventEmitter();
  Object.assign(app, {
    isPackaged: false,
    setName() {},
    getPath: () => profile.root,
    setPath() {},
    setAppLogsPath() {},
    getVersion: () => "0.1.0",
    getAppMetrics: () => [],
    quit() {
      let prevented = false;
      app.emit("before-quit", {
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) calls.quitCompleted++;
    },
  });
  const sourceUrl = pathToFileURL(path.join(projectDir, "frontend/dist/index.html")).href;
  const win = { webContents: { mainFrame: { url: sourceUrl } } };
  const event = {
    sender: win.webContents,
    senderFrame: win.webContents.mainFrame,
  };
  const image = {
    resize() {
      return this;
    },
  };
  const mocks = {
    electron: {
      app,
      ipcMain: {
        handle: (name, callback) => handlers.set(name, callback),
        on() {},
      },
      shell: {},
      net: {
        fetch() {
          throw new Error("生命周期测试禁止联网");
        },
      },
      Tray,
      nativeImage: { createFromPath: () => image },
      Menu: { buildFromTemplate: (value) => value, setApplicationMenu() {} },
      clipboard: {
        readText() {
          return "";
        },
        writeText() {
          throw new Error("生命周期测试禁止写入剪贴板");
        },
      },
      globalShortcut: {
        register() {
          return false;
        },
        unregister() {},
        unregisterAll() {},
      },
      dialog: { showOpenDialog: async () => ({ filePaths: [] }) },
    },
    "./services/profiles.cjs": { resolveProfile: () => profile },
    "./services/background-test.cjs": require("../../electron/services/background-test.cjs"),
    "./services/java-runtime.cjs": { JavaRuntime: Core },
    "./services/text-dictionary.cjs": {
      TextDictionaryService: class {
        async ensure() {
          await options.ensure?.();
        }
        status() {
          return { edition: "core-text", ready: true };
        }
        async close() {}
      },
    },
    "./services/pronunciation.cjs": {
      PronunciationService: class {
        close() {}
        async settings() {
          return {};
        }
      },
    },
    "./services/lmcp/gateway.cjs": {
      LmcpGateway: class {
        async start() {
          calls.gatewayStarts++;
        }
        async close() {
          calls.gatewayStops++;
        }
        status() {
          return {
            running: calls.gatewayStarts > calls.gatewayStops,
            lastError: null,
          };
        }
        manage() {
          return Promise.resolve({ clients: [] });
        }
      },
    },
    "./services/connection-settings.cjs": {
      ConnectionSettings: class {
        action() {
          return Promise.resolve({ clients: [] });
        }
      },
    },
    "./services/browser-discovery.cjs": require("../../electron/services/browser-discovery.cjs"),
    "./services/connection-notifications.cjs": require("../../electron/services/connection-notifications.cjs"),
    "./services/plugin-capture-notifications.cjs": require("../../electron/services/plugin-capture-notifications.cjs"),
    "./services/developer-monitor.cjs": { DeveloperMonitor: Monitor },
    "./services/desktop-controller.cjs": { DesktopController: Desktop },
    "./services/business-clock.cjs": { businessClock },
    "./services/bridge.cjs": { createBridge, METHODS },
    "./services/egg-application.cjs": { scopedEggClass: () => Egg },
    "./services/app-updater.cjs": {
      AppUpdater: class {
        configured() {
          return false;
        }
        async check() {
          return { status: "not-configured", pauseSupported: false };
        }
        close() {
          this.inflight?.abort();
        }
      },
    },
    "./services/desktop-navigation.cjs": require("../../electron/services/desktop-navigation.cjs"),
    "./services/study-notifications.cjs": require("../../electron/services/study-notifications.cjs"),
    "./services/clipboard-inbox.cjs": require("../../electron/services/clipboard-inbox.cjs"),
    "./services/capture-window.cjs": require("../../electron/services/capture-window.cjs"),
    "./services/native-capture.cjs": {
      NativeCaptureService: class {
        apply() {}
        close() {}
        snapshot() {
          return {
            clipboardEnabled: false,
            shortcutEnabled: false,
            reads: 0,
            writes: 0,
            historyStored: false,
          };
        }
      },
    },
    "./services/portable-backup.cjs": {
      PortableBackupService: class {
        async export() {
          throw new Error("生命周期测试禁止文件备份");
        }
        async restore() {
          throw new Error("生命周期测试禁止文件恢复");
        }
      },
    },
    "ee-core": { ElectronEgg: Egg },
    "ee-core/electron": { getMainWindow: () => win },
  };
  const context = vm.createContext({
    __dirname: path.dirname(mainPath),
    console,
    Buffer,
    process: {
      env: {},
      platform: "win32",
      versions: process.versions,
      on() {},
    },
    require(name) {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (["node:path", "node:url", "node:events"].includes(name)) return require(name);
      if (name === "./services/study-reminder.cjs")
        return {
          StudyReminder: class {
            start() {}
            close() {}
          },
        };
      throw new Error(`生命周期测试拒绝未声明依赖：${name}`);
    },
  });
  vm.runInContext(fs.readFileSync(mainPath, "utf8"), context, {
    filename: mainPath,
  });
  t.after(() => {
    monitor.close();
    desktop.close();
  });
  return {
    app,
    calls,
    trays,
    core,
    monitor,
    desktop,
    start: () => eggEvents.get("electron-app-ready")(),
    invoke: (method, payload) => handlers.get(`leximeet:${method}`)(event, payload),
  };
}

test("Core 启动未完成时退出，迟到启动成功不能再请求快照或创建采集器", async (t) => {
  const starting = deferred(),
    stopping = deferred();
  const main = mainFixture(t, {
    start: () => starting.promise,
    stop: () => stopping.promise,
  });
  main.start();
  main.app.quit();
  const response = main.invoke("snapshot");
  starting.resolve();
  assert.equal((await response).ok, false);
  assert.deepEqual(main.calls.requests, []);
  assert.equal(main.monitor.enabled, false);
  assert.equal(main.calls.traysCreated, 0);
  assert.equal(main.calls.quitCompleted, 0, "须等待 Core 停止后完成退出");
  stopping.resolve();
  await flush();
  assert.equal(main.calls.quitCompleted, 1);
  assert.equal(main.calls.gatewayStarts, 1, "本机网关只启动一次，退出后不能复活");
  assert.equal(main.calls.gatewayStops, 1, "退出必须关闭独立连接网关");
});

test("首个快照在退出后返回，不能重新开启监控或复活 Windows 托盘", async (t) => {
  const snapshot = deferred(),
    stopping = deferred();
  const main = mainFixture(t, {
    request: () => snapshot.promise,
    stop: () => stopping.promise,
  });
  main.start();
  await flush();
  assert.equal(main.calls.requests.length, 1);
  main.app.quit();
  const response = main.invoke("snapshot");
  snapshot.resolve({
    words: [],
    settings: {
      ...initialSettings(),
      closeBehavior: "hide",
      developerMonitoringEnabled: true,
    },
  });
  const result = await response;
  assert.equal(result.ok, false);
  assert.match(result.error, /退出/);
  assert.equal(main.monitor.enabled, false);
  assert.equal(main.monitor.delay == null, true);
  assert.equal(main.calls.traysCreated, 0);
  assert.equal(main.trays.size, 0);
  stopping.resolve();
  await flush();
  assert.equal(main.calls.quitCompleted, 1);
  assert.equal(main.calls.gatewayStarts, 1, "本机网关只启动一次，退出后不能复活");
  assert.equal(main.calls.gatewayStops, 1, "退出必须关闭独立连接网关");
});

test("重启等待停止期间退出，合并的重启请求全部取消且只清理现有资源", async (t) => {
  const stopping = deferred();
  const main = mainFixture(t, {
    stop: () => stopping.promise,
    request: async () => ({
      words: [],
      settings: {
        ...initialSettings(),
        closeBehavior: "hide",
        developerMonitoringEnabled: true,
      },
    }),
  });
  main.start();
  await flush();
  assert.equal(main.trays.size, 1);
  assert.equal(main.monitor.enabled, true);
  const first = main.invoke("desktopAction", { action: "restartCore" });
  const second = main.invoke("desktopAction", { action: "restartCore" });
  assert.equal(main.calls.stops, 1, "并发重启复用同一次停止");
  main.app.quit();
  assert.equal(main.trays.size, 0);
  assert.equal(main.monitor.enabled, false);
  stopping.resolve();
  for (const result of await Promise.all([first, second])) {
    assert.equal(result.ok, false);
    assert.match(result.error, /退出/);
  }
  await flush();
  assert.equal(main.calls.starts, 1, "退出后不得启动第二个 Core");
  assert.equal(main.calls.traysCreated, 1, "销毁后不能再创建托盘");
  assert.equal(main.calls.quitCompleted, 1);
  assert.equal(main.calls.gatewayStarts, 1);
  assert.equal(main.calls.gatewayStops, 1, "退出必须关闭独立连接网关");
});

test("Core 首次启动失败仍能读取运行状态并通过命名操作恢复业务", async (t) => {
  const main = mainFixture(t, {
    start: async (attempt) => {
      if (attempt === 1) throw new Error("测试启动失败");
    },
  });
  main.start();
  await flush();
  const status = await main.invoke("runtime");
  assert.equal(status.ok, true);
  assert.equal(status.value.coreState, "failed");
  assert.match(status.value.coreError, /测试启动失败/);
  assert.equal((await main.invoke("snapshot")).ok, false);
  const recovery = await main.invoke("desktopAction", {
    action: "restartCore",
  });
  assert.equal(recovery.ok, true);
  assert.equal(recovery.value.runtime.coreState, "ready");
  assert.equal((await main.invoke("snapshot")).ok, true);
  assert.equal(main.calls.starts, 2);
  assert.equal(main.calls.stops, 1);
});

test("原生策略失败的补偿提交完成前，后续设置不能越过队列或被旧回滚覆盖", async (t) => {
  const firstResponse = deferred(),
    compensation = deferred();
  const calls = [];
  let stored = initialSettings();
  const desktop = new DesktopController({
    app: { isPackaged: false },
    profile: { name: "test" },
    platform: "win32",
    createTray() {
      throw new Error("测试托盘失败");
    },
  });
  const monitor = new DeveloperMonitor();
  t.after(() => {
    monitor.close();
    desktop.close();
  });
  const bridge = createBridge({
    desktop,
    monitor,
    profile: { name: "test" },
    core: {
      async request(route, method, patch) {
        if (route === "/api/settings" && (!method || method === "GET"))
          return { settings: { ...stored } };
        assert.equal(route, "/api/settings");
        assert.equal(method, "PATCH");
        calls.push({ ...patch });
        stored = { ...stored, ...patch };
        const response = { settings: { ...stored } };
        if (calls.length === 1) await firstResponse.promise;
        if (calls.length === 2) await compensation.promise;
        return response;
      },
    },
  });
  const failed = assert.rejects(bridge.settings({ closeBehavior: "hide" }), /测试托盘失败/);
  const later = bridge.settings({ closeBehavior: "quit" });
  await flush();
  assert.deepEqual(calls, [{ closeBehavior: "hide" }]);
  firstResponse.resolve();
  await flush();
  assert.deepEqual(calls, [{ closeBehavior: "hide" }, initialSettings()]);
  assert.equal(desktop.settings.closeBehavior, "platform");
  compensation.resolve();
  await failed;
  assert.equal((await later).settings.closeBehavior, "quit");
  assert.equal(stored.closeBehavior, "quit");
  assert.equal(desktop.settings.closeBehavior, "quit");
  assert.equal(calls.length, 3, "原补偿不能在后续成功之后再提交");
});

test("备份导入和设置共用顺序，导入重置的隐私状态不会覆盖其后的显式设置", async (t) => {
  const firstResponse = deferred(),
    importResponse = deferred();
  const calls = [],
    applied = [];
  let stored = initialSettings();
  class Monitor extends DeveloperMonitor {
    setEnabled(value) {
      applied.push(value);
      super.setEnabled(value);
    }
  }
  const monitor = new Monitor();
  t.after(() => monitor.close());
  const bridge = createBridge({
    monitor,
    profile: { name: "test" },
    core: {
      async request(route, _method, patch) {
        calls.push(route);
        stored = route === "/api/import" ? initialSettings() : { ...stored, ...patch };
        const response = { settings: { ...stored } };
        if (calls.length === 1) await firstResponse.promise;
        if (route === "/api/import") await importResponse.promise;
        return response;
      },
    },
  });
  const first = bridge.settings({ developerMonitoringEnabled: true });
  const imported = bridge.importData({ schemaVersion: 1, words: [] });
  const later = bridge.settings({ developerMonitoringEnabled: true });
  await flush();
  assert.deepEqual(calls, ["/api/settings"]);
  firstResponse.resolve();
  await first;
  await flush();
  assert.deepEqual(calls, ["/api/settings", "/api/import"]);
  assert.equal(monitor.enabled, true);
  importResponse.resolve();
  assert.equal((await imported).settings.developerMonitoringEnabled, false);
  await later;
  assert.deepEqual(calls, ["/api/settings", "/api/import", "/api/settings"]);
  assert.deepEqual(applied, [true, false, true]);
  assert.equal(stored.developerMonitoringEnabled, true);
  assert.equal(monitor.enabled, true);
});

test("完整文件恢复与设置写入共用顺序，迟到的旧设置不能越过恢复", async (t) => {
  const firstResponse = deferred(),
    restoreResponse = deferred();
  const calls = [];
  const monitor = new DeveloperMonitor();
  t.after(() => monitor.close());
  const bridge = createBridge({
    monitor,
    profile: { name: "test" },
    desktop: {
      async action(payload) {
        calls.push(payload.action);
        await restoreResponse.promise;
        return { ok: true, action: payload.action };
      },
    },
    core: {
      async request(route) {
        calls.push(route);
        if (calls.length === 1) await firstResponse.promise;
        return { settings: initialSettings() };
      },
    },
  });
  const first = bridge.cardLayout({ expectedRevision: 0 });
  const restore = bridge.desktopAction({ action: "restoreArchive" });
  const later = bridge.cardLayout({ expectedRevision: 1 });
  await flush();
  assert.deepEqual(calls, ["/api/card-layout"]);
  firstResponse.resolve();
  await first;
  await flush();
  assert.deepEqual(calls, ["/api/card-layout", "restoreArchive"]);
  restoreResponse.resolve();
  await restore;
  await later;
  assert.deepEqual(calls, ["/api/card-layout", "restoreArchive", "/api/card-layout"]);
});

test("多字段设置遇到原生失败时全部补偿，不留下 Core 独自开启的监控或联网授权", async (t) => {
  const previous = {
    ...initialSettings(),
    theme: "light",
    clipboardCaptureEnabled: false,
  };
  let stored = { ...previous },
    coreMonitoringEnabled = false;
  const patches = [];
  const desktop = new DesktopController({
    app: { isPackaged: false },
    profile: { name: "test" },
    platform: "win32",
    createTray() {
      throw new Error("测试托盘失败");
    },
  });
  desktop.apply(previous);
  const monitor = new DeveloperMonitor();
  t.after(() => {
    monitor.close();
    desktop.close();
  });
  const bridge = createBridge({
    desktop,
    monitor,
    profile: { name: "test" },
    core: {
      async request(route, method, patch) {
        // 与真实 Core 一致：设置提交成功即应用 Core 监控开关；允许实现先读取权威旧设置。
        if (route === "/api/settings" && method === "PATCH") {
          patches.push(patch);
          stored = { ...stored, ...patch };
          coreMonitoringEnabled = stored.developerMonitoringEnabled;
        } else if (route !== "/api/settings" || (method && method !== "GET"))
          throw new Error(`测试未定义 Core 请求：${route}`);
        return { settings: { ...stored } };
      },
    },
  });
  await assert.rejects(
    bridge.settings({
      closeBehavior: "hide",
      developerMonitoringEnabled: true,
      clipboardCaptureEnabled: true,
      theme: "dark",
    }),
    /测试托盘失败/,
  );
  assert.deepEqual(stored, previous, "保存报错后不能保留同一 patch 中的主题或隐私设置");
  assert.deepEqual(desktop.settings, previous);
  assert.equal(coreMonitoringEnabled, false, "Core 的采集授权必须一起恢复");
  assert.equal(monitor.enabled, false, "Main 和 Core 的授权状态必须一致");
});

test("补偿写入失败时读回 Core 的真实监控状态并明确报错，后续设置仍可恢复", async (t) => {
  const previous = {
    ...initialSettings(),
    theme: "light",
    clipboardCaptureEnabled: false,
  };
  let stored = { ...previous },
    coreMonitoringEnabled = false,
    writes = 0,
    readBacks = 0;
  const desktop = new DesktopController({
    app: { isPackaged: false },
    profile: { name: "test" },
    platform: "win32",
    createTray() {
      throw new Error("测试托盘失败");
    },
  });
  desktop.apply(previous);
  const monitor = new DeveloperMonitor();
  t.after(() => {
    monitor.close();
    desktop.close();
  });
  const bridge = createBridge({
    desktop,
    monitor,
    profile: { name: "test" },
    core: {
      async request(route, method, patch) {
        if (route === "/api/settings" && (!method || method === "GET")) {
          if (writes >= 2) readBacks++;
        } else if (route === "/api/settings" && method === "PATCH") {
          // 第二次写入是补偿；模拟数据库拒绝它，保留第一次实际提交的设置。
          if (++writes === 2) throw new Error("测试补偿写入失败");
          stored = { ...stored, ...patch };
          coreMonitoringEnabled = stored.developerMonitoringEnabled;
        } else throw new Error(`测试未定义 Core 请求：${route}`);
        return { settings: { ...stored } };
      },
    },
  });
  await assert.rejects(
    bridge.settings({
      closeBehavior: "hide",
      developerMonitoringEnabled: true,
      clipboardCaptureEnabled: true,
      theme: "dark",
    }),
    (error) => {
      assert.match(error.message, /恢复.*(?:失败|未完成)/);
      assert.match(error.message, /刷新/);
      return true;
    },
  );
  assert.ok(readBacks > 0, "补偿失败后必须读取 Core 的当前状态");
  assert.equal(stored.developerMonitoringEnabled, true);
  assert.equal(coreMonitoringEnabled, true);
  assert.equal(monitor.enabled, true, "不能继续报告 Main 关闭而 Core 仍采集");
  assert.equal(desktop.settings.closeBehavior, "platform", "失败的托盘策略没有实际生效");
  const recovered = await bridge.settings({
    closeBehavior: "quit",
    developerMonitoringEnabled: false,
    clipboardCaptureEnabled: false,
    theme: "light",
  });
  assert.deepEqual(recovered.settings, { ...previous, closeBehavior: "quit" });
  assert.equal(desktop.settings.closeBehavior, "quit");
  assert.equal(monitor.enabled, false);
  assert.equal(coreMonitoringEnabled, false);
});
