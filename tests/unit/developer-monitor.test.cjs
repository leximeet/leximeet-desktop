const test = require("node:test");
const assert = require("node:assert/strict");
const { DeveloperMonitor } = require("../../electron/services/developer-monitor.cjs");
const { createBridge } = require("../../electron/services/bridge.cjs");
const { DesktopController } = require("../../electron/services/desktop-controller.cjs");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");

test("自监控默认关闭，不调用进程采样；关闭后释放采集器并清空统计", async (t) => {
  let reads = 0;
  const monitor = new DeveloperMonitor({
    processes: () => {
      reads++;
      return [];
    },
  });
  t.after(() => monitor.close());
  assert.deepEqual(monitor.snapshot(), { enabled: false });
  assert.equal(monitor.delay, undefined);
  assert.equal(await monitor.measure("snapshot", async () => 42), 42);
  assert.equal(reads, 0);
  assert.equal(monitor.operations.size, 0);
  monitor.setEnabled(true);
  await monitor.measure("dictionaryAction", async () => "private word");
  const report = monitor.snapshot();
  assert.equal(report.operations[0].count, 1);
  assert.ok(report.main.rssBytes > 0);
  assert.equal(JSON.stringify(report).includes("private word"), false);
  monitor.setEnabled(false);
  assert.equal(monitor.delay, null);
  assert.equal(monitor.operations.size, 0);
  assert.deepEqual(monitor.snapshot(), { enabled: false });
  assert.equal(reads, 1);
});

test("在途请求跨越关闭/重新开启时不能污染新会话，同步错误保持原语义", async (t) => {
  const monitor = new DeveloperMonitor();
  t.after(() => monitor.close());
  monitor.setEnabled(true);
  let resolve;
  const pending = monitor.measure(
    "dictionaryAction",
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  monitor.setEnabled(false);
  monitor.setEnabled(true);
  resolve("old result");
  await pending;
  assert.deepEqual(monitor.snapshot().operations, []);
  assert.throws(
    () =>
      monitor.measure("desktopCommand", () => {
        throw new Error("private context");
      }),
    /private context/,
  );
  const [row] = monitor.snapshot().operations;
  assert.equal(row.errorCount, 1);
  assert.equal(row.method, "desktopCommand");
  assert.equal(JSON.stringify(monitor.snapshot()).includes("private context"), false);
});

test("诊断桥关闭时不请求核心；开启后只返回有界数值聚合并支持关闭竞态", async (t) => {
  const monitor = new DeveloperMonitor();
  t.after(() => monitor.close());
  let calls = 0,
    delayed;
  const bridge = createBridge({
    monitor,
    core: {
      request: async () => {
        calls++;
        if (delayed) await delayed;
        return { enabled: true, jvm: { heapUsedBytes: 20 } };
      },
    },
    profile: { name: "test", root: "/test", coreDir: "/test/core" },
  });
  assert.deepEqual(await bridge.diagnostics(), { enabled: false });
  assert.equal(calls, 0);
  monitor.setEnabled(true);
  assert.equal((await bridge.diagnostics()).core.jvm.heapUsedBytes, 20);
  let finish;
  delayed = new Promise((done) => {
    finish = done;
  });
  const pending = bridge.diagnostics();
  monitor.setEnabled(false);
  finish();
  assert.deepEqual(await pending, { enabled: false });
});

test("旧快照和旧诊断不能重新开启或覆盖新监控会话", async (t) => {
  const monitor = new DeveloperMonitor();
  t.after(() => monitor.close());
  monitor.setEnabled(true);
  let finishSnapshot, finishDiagnostics;
  const bridge = createBridge({
    monitor,
    core: {
      request: async (route) => {
        if (route === "/api/snapshot")
          return new Promise((resolve) => {
            finishSnapshot = resolve;
          });
        if (route === "/api/diagnostics")
          return new Promise((resolve) => {
            finishDiagnostics = resolve;
          });
        return { settings: { developerMonitoringEnabled: false } };
      },
    },
    profile: { name: "test", root: "/test", coreDir: "/test/core" },
  });
  const snapshot = bridge.snapshot();
  await bridge.settings({ developerMonitoringEnabled: false });
  finishSnapshot({ settings: { developerMonitoringEnabled: true } });
  await snapshot;
  assert.equal(monitor.enabled, false);
  monitor.setEnabled(true);
  const pending = bridge.diagnostics();
  monitor.setEnabled(false);
  monitor.setEnabled(true);
  finishDiagnostics({ enabled: true, jvm: { heapUsedBytes: 999 } });
  assert.deepEqual(await pending, { enabled: false });
  assert.equal(monitor.enabled, true, "旧请求不能关闭新会话");
});

test("旧Java请求失败或迟到成功不覆盖重启后的状态和数据", async (t) => {
  const original = global.fetch;
  t.after(() => {
    global.fetch = original;
  });
  const runtime = new JavaRuntime({ jarPath: "/unused", dataDir: "/unused" });
  runtime.port = 12345;
  runtime.state = "ready";
  let rejectOld;
  global.fetch = () =>
    new Promise((_, reject) => {
      rejectOld = reject;
    });
  const pending = runtime.request("/api/snapshot");
  runtime.generation++;
  runtime.state = "ready";
  rejectOld(new Error("old connection"));
  await assert.rejects(pending, /已重启/);
  assert.equal(runtime.state, "ready");
  let resolveOld;
  global.fetch = () =>
    new Promise((resolve) => {
      resolveOld = resolve;
    });
  const oldSuccess = runtime.request("/api/snapshot");
  runtime.generation++;
  resolveOld(new Response(JSON.stringify({ words: ["old"] })));
  await assert.rejects(oldSuccess, /已重启/);
  assert.equal(runtime.state, "ready");
});

test("关闭系统登录项也必须校验真实状态，不能把无效setter当成功", () => {
  const desktop = new DesktopController({
    app: {
      isPackaged: true,
      setLoginItemSettings() {},
      getLoginItemSettings: () => ({ openAtLogin: true }),
    },
    profile: { name: "local" },
    platform: "darwin",
  });
  desktop.settings.launchAtLogin = true;
  assert.throws(
    () =>
      desktop.apply(
        { launchAtLogin: false, closeBehavior: "platform" },
        { changedKeys: ["launchAtLogin"] },
      ),
    /状态.*不一致/,
  );
  assert.equal(desktop.settings.launchAtLogin, true);
});

test("原生操作只允许固定动作/本机目录，验收环境不能修改系统登录项", async () => {
  const opened = [];
  const desktop = new DesktopController({
    app: { isPackaged: true },
    shell: {
      openPath: async (value) => {
        opened.push(value);
        return "";
      },
    },
    profile: { name: "test", root: "/owned/test" },
    platform: "darwin",
    restartCore: async () => {},
    runtime: () => ({ coreState: "ready" }),
  });
  assert.equal(desktop.shouldHide(), true);
  assert.throws(() => desktop.validateSettings({ launchAtLogin: true }), /验收环境/);
  assert.equal(desktop.capabilities().launchAtLogin.status, "unsupported");
  assert.equal(desktop.capabilities().updates.status, "not-configured");
  for (const payload of [{ action: "exec" }, { action: "showDataFolder", path: "/etc" }, null])
    await assert.rejects(desktop.action(payload));
  await desktop.action({ action: "showDataFolder" });
  await desktop.action({ action: "showLogsFolder" });
  assert.deepEqual(opened, ["/owned/test", "/owned/test/logs"]);
  desktop.apply({ closeBehavior: "quit", launchAtLogin: false });
  assert.equal(desktop.shouldHide(), false);
  assert.equal((await desktop.action({ action: "restartCore" })).runtime.coreState, "ready");
});

test("Windows隐藏策略需要可恢复托盘，系统设置失败时恢复已写入的设备策略", async () => {
  const calls = [];
  const previous = {
    developerMonitoringEnabled: false,
    launchAtLogin: false,
    closeBehavior: "platform",
  };
  let stored = { ...previous };
  const desktop = new DesktopController({
    app: { isPackaged: false },
    shell: {},
    profile: { name: "dev" },
    platform: "win32",
    createTray: () => {
      throw new Error("托盘不可用");
    },
  });
  const bridge = createBridge({
    desktop,
    core: {
      request: async (route, method, body) => {
        if (route === "/api/settings" && !method) return { settings: { ...stored } };
        assert.equal(route, "/api/settings");
        assert.equal(method, "PATCH");
        calls.push(body);
        stored = { ...stored, ...body };
        return { settings: { ...stored } };
      },
    },
    profile: { name: "dev", root: "/dev", coreDir: "/dev/core" },
  });
  await assert.rejects(bridge.settings({ closeBehavior: "hide" }), /托盘不可用/);
  assert.deepEqual(calls, [{ closeBehavior: "hide" }, previous]);
  assert.deepEqual(stored, previous);
  assert.equal(desktop.shouldHide(), false);
});
