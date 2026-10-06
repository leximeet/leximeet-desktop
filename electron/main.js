const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  app,
  BrowserWindow,
  Notification,
  ipcMain,
  shell,
  net,
  Menu,
  Tray,
  nativeImage,
  clipboard,
  globalShortcut,
  dialog,
  safeStorage,
} = require("electron");
// 在加载框架、创建首个窗口前安装；不能等到 renderer 就绪后才开始保护。
const { isBackgroundTest, installBackgroundTest } = require("./services/background-test.cjs");
const silentTest = isBackgroundTest(process.env);
const backgroundTest = installBackgroundTest({
  app,
  shell,
  dialog,
  env: process.env,
  platform: process.platform,
});
if (backgroundTest) globalThis.__leximeetTestBackground = backgroundTest;
const { resolveProfile } = require("./services/profiles.cjs");
const { JavaRuntime } = require("./services/java-runtime.cjs");
const { LmcpGateway } = require("./services/lmcp/gateway.cjs");
const { ConnectionSettings } = require("./services/connection-settings.cjs");
const { PluginCaptureNotifications } = require("./services/plugin-capture-notifications.cjs");
const { BrowserDiscovery } = require("./services/browser-discovery.cjs");
const { ConnectionNotifications } = require("./services/connection-notifications.cjs");
const { DesktopNavigation } = require("./services/desktop-navigation.cjs");
const { DeveloperMonitor } = require("./services/developer-monitor.cjs");
const { DesktopController } = require("./services/desktop-controller.cjs");
const { AppUpdater } = require("./services/app-updater.cjs");
const { StudyReminder } = require("./services/study-reminder.cjs");
const { ClipboardInbox } = require("./services/clipboard-inbox.cjs");
const { CaptureWindows } = require("./services/capture-window.cjs");
const { NativeCaptureService } = require("./services/native-capture.cjs");
const { PortableBackupService } = require("./services/portable-backup.cjs");
const { TextDictionaryService } = require("./services/text-dictionary.cjs");
const { PronunciationService } = require("./services/pronunciation.cjs");
const monitor = new DeveloperMonitor({ processes: () => app.getAppMetrics() });

const projectDir = path.resolve(__dirname, "..");
app.setName("LexiMeet");
const profile = resolveProfile({
  name: process.env.LEXIMEET_PROFILE || (app.isPackaged ? "local" : "dev"),
  dataDir: process.env.LEXIMEET_DATA_DIR,
  projectDir,
  userData: path.join(app.getPath("appData"), "LexiMeet"),
});
// 在导入框架和 ready 之前设置 Chromium 的目录，避免启动即写入默认 Electron 缓存。
app.setPath("userData", profile.root);
app.setPath("sessionData", profile.sessionDir);
app.setAppLogsPath(path.join(profile.root, "logs"));
const studyNow = require("./services/business-clock.cjs").businessClock({
  profile,
  file: process.env.LEXIMEET_TEST_CLOCK_FILE || "",
});
const core = new JavaRuntime({
  jarPath: app.isPackaged
    ? path.join(process.resourcesPath, "core/leximeet-core.jar")
    : path.join(projectDir, "core-java/target/leximeet-core.jar"),
  ...(app.isPackaged
    ? {
        java: path.join(
          process.resourcesPath,
          "runtime/bin",
          process.platform === "win32" ? "java.exe" : "java",
        ),
      }
    : {}),
  dataDir: profile.coreDir,
  profile: profile.name,
  testClockFile: process.env.LEXIMEET_TEST_CLOCK_FILE || "",
  demo: ["demo", "test"].includes(profile.name) && process.env.LEXIMEET_SEED_DEMO === "1",
  // 连续隔离启动出现过 20s 冷启动超时；保留有界期限，给类加载和原生库解压留余量。
  timeout: 45000,
});
const { ElectronEgg } = require("ee-core");
const { getMainWindow } = require("ee-core/electron");
const { createBridge, METHODS } = require("./services/bridge.cjs");
const { scopedEggClass } = require("./services/egg-application.cjs");
const LexiMeetEgg = scopedEggClass(ElectronEgg, {
  electronDir: __dirname,
  profile,
});
const egg = new LexiMeetEgg();
const sourceUrl = pathToFileURL(path.join(projectDir, "frontend/dist/index.html")).href;
let ready;
let textDictionary, pronunciation;
let quitting = false;
let shutdownFinished = false;
let restarting = null;
const updater = new AppUpdater({
  feedUrl: process.env.LEXIMEET_UPDATE_FEED || "",
  downloadDir: path.join(profile.root, "updates"),
  fetchImpl: (...args) => net.fetch(...args),
  currentVersion: app.getVersion(),
  allowInsecureLocal: profile.name === "test",
});
// 测试只替换系统输入和通知投递，仍运行同一 Main 队列与真实 SQLite。
const TestNotification = require("node:events").EventEmitter;
class SilentNotification extends TestNotification {
  static isSupported() {
    return true;
  }
  constructor(options) {
    super();
    this.options = options;
  }
  show() {
    queueMicrotask(() => this.emit("show"));
  }
  close() {}
}
let captureWindows;
const notifyChanged = () => {
  try {
    getMainWindow()?.webContents.send("leximeet:data-changed");
    captureWindows?.publish();
  } catch {}
};
const saveCapture = async (data) => {
  await ready;
  const result = await core.request("/api/desktop/command", "POST", data);
  // 包括原回执恢复都刷新读模型；这不是新采集事件，也不增加成功通知。
  notifyChanged();
  return result;
};
const inbox = new ClipboardInbox({
  Notification: silentTest ? SilentNotification : Notification,
  match: async (words, text) => {
    await ready;
    return core.request("/api/desktop/query", "POST", {
      kind: "clipboardCandidates",
      words,
      text,
    });
  },
  save: saveCapture,
  changed: notifyChanged,
  fallback: () => captureWindows?.open("inbox", null, false).catch(() => {}),
});
captureWindows = new CaptureWindows({
  BrowserWindow,
  sourceUrl,
  projectDir,
  silent: silentTest,
  save: saveCapture,
  theme: async () => (await core.request("/api/settings")).settings.theme,
  inbox,
  retryClipboard: () => capture.retryPreview(),
});
const capture = new NativeCaptureService({
  clipboard:
    profile.name === "test"
      ? {
          readText: () => process.env.LEXIMEET_TEST_CLIPBOARD_TEXT || "",
          writeText() {
            throw new Error("测试禁止写入系统剪贴板");
          },
        }
      : clipboard,
  globalShortcut:
    profile.name === "test" ? { register: () => true, unregister() {} } : globalShortcut,
  sendPreview: (payload) => {
    if (payload.source === "shortcut") captureWindows.open().catch(() => {});
    if (payload.source === "clipboard") return inbox.accept(payload);
    if (payload.source === "cleared") inbox.cancel();
  },
});
const applyCapture = capture.apply.bind(capture);
capture.apply = (settings) => {
  inbox.apply(settings);
  applyCapture(settings);
};
if (silentTest)
  globalThis.__leximeetTestCapture = {
    poll: () => capture.poll(),
    snapshot: () => inbox.snapshot(),
    notification: (id) => inbox.items.get(id)?.notification,
    openInbox: () => captureWindows.open("inbox"),
    shortcut: () => captureWindows.open(),
  };
const { StudyNotifications } = require("./services/study-notifications.cjs");
const studyNotifications = new StudyNotifications({
  now: studyNow,
  Notification: silentTest ? SilentNotification : Notification,
  request: (data) => core.request("/api/desktop/command", "POST", data),
  play:
    process.platform === "darwin"
      ? (word) =>
          require("./services/reminder-audio.cjs").playReminderAudio(pronunciation, word, {
            silent: silentTest,
          })
      : null,
  open: showMainWindow,
  changed: notifyChanged,
});
const studyReminder = new StudyReminder({
  now: studyNow,
  file: path.join(profile.root, "study-reminders.json"),
  state: () => core.request("/api/desktop/state"),
  focused: () => Boolean(getMainWindow()?.isFocused()),
  notify: () => studyNotifications.issue(),
});
if (silentTest)
  globalThis.__leximeetTestStudy = {
    issue: () => studyNotifications.issue(),
    notice: (id) => studyNotifications.notices.get(id)?.notice,
    status: () => studyNotifications.status,
    tick: () => studyReminder.tick(),
    schedule: () => ({ ...studyReminder.record }),
  };

const archive = new PortableBackupService({ core, dialog, profile });
const desktop = new DesktopController({
  app,
  shell,
  profile,
  restartCore: restartCore,
  runtime: () => bridge.runtime(),
  showWindow: showMainWindow,
  updater,
  capture,
  archive,
  // 文件备份界面尚未开放；保留底层能力，供正式入口后续接入。
  fileBackupsEnabled: false,
  createTray: () => {
    const icon = nativeImage.createFromPath(path.join(projectDir, "resources/brand/icon.png"));
    const tray = new Tray(icon.resize({ width: 20, height: 20 }));
    tray.setToolTip("词遇 LexiMeet");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "打开词遇", click: showMainWindow },
        { type: "separator" },
        { label: "退出词遇", click: () => app.quit() },
      ]),
    );
    tray.on("double-click", showMainWindow);
    tray.on("click", showMainWindow);
    return tray;
  },
});
const desktopNavigation = new DesktopNavigation({
  getWindow: getMainWindow,
  showWindow: showMainWindow,
});
ipcMain.on("leximeet:navigation-ack", (event, value) =>
  desktopNavigation.acknowledge(event, value),
);
const connector = new LmcpGateway({
  core,
  profile,
  awaitReady: () => ready,
  onDataChanged: () => {
    try {
      getMainWindow()?.webContents.send("leximeet:data-changed");
    } catch {
      // 首屏会从 Core 读取最新资料。
    }
  },
  onOpenInDesktop: (params, result) => desktopNavigation.open(params, result),
  onDiscovery: (client) => connectionNotifications.discover(client),
  onConnectionReady: (client) => connectionNotifications.connectionReady(client),
  onCaptureCommitted: (commit) => pluginCaptureNotifications.captureCommitted(commit),
});
const connectionSettings = new ConnectionSettings({
  gateway: connector,
  profile,
  electronExecutable: process.execPath,
  hostScript: app.isPackaged
    ? path.join(process.resourcesPath, "native-host", "host", "main.cjs")
    : path.join(projectDir, "electron", "native-host", "main.cjs"),
  homeDir: app.getPath("home"),
  discoveryStatus: () => browserDiscovery.snapshot(),
});
const browserDiscovery = new BrowserDiscovery({
  profile,
  homeDir: app.getPath("home"),
  connectionSettings,
  enabled: !silentTest,
});
const connectionNotifications = new ConnectionNotifications({
  Notification: silentTest ? SilentNotification : Notification,
  gateway: connector,
  changed: notifyChanged,
});
const pluginCaptureNotifications = new PluginCaptureNotifications({
  Notification: silentTest ? SilentNotification : Notification,
  profile,
  settings: async () => (await core.request("/api/settings")).settings,
  changed: notifyChanged,
});
const bridge = createBridge({
  core,
  profile,
  openExternal: (url) => shell.openExternal(url),
  versions: process.versions,
  monitor,
  desktop,
  appInfo: { version: app.getVersion(), packaged: app.isPackaged },
});
bridge.connectionSettings = async (input) => {
  if (input?.action === "scan") {
    if (Object.keys(input).length !== 1) throw new Error("连接检查参数无效");
    await browserDiscovery.scan();
    return connectionSettings.action({ action: "state" });
  }
  const result = await connectionSettings.action(input);
  if (!input || input.action === "state")
    return { ...result, notifications: connectionNotifications.snapshot() };
  notifyChanged();
  return result;
};
textDictionary = new TextDictionaryService({
  core,
  profile,
  bundledPath: app.isPackaged
    ? path.join(process.resourcesPath, "dictionary")
    : path.join(projectDir, "resources/dictionary"),
  fetchImpl: (...args) => net.fetch(...args),
  localSource: process.env.LEXIMEET_DICTIONARY_SOURCE,
  changed: () => {
    try {
      getMainWindow()?.webContents.send("leximeet:data-changed");
    } catch {}
  },
});
pronunciation = new PronunciationService({
  directory: profile.root,
  safeStorage,
  fetchImpl: (...args) => net.fetch(...args),
  nativeEvent: async (event) => {
    await core.request("/api/desktop/guide-native", "POST", { event });
    getMainWindow()?.webContents.send("leximeet:data-changed");
  },
});
bridge.captureAction = (value) => captureWindows.action(value);
bridge.desktopState = async () => ({
  ...(await core.request("/api/desktop/state")),
  reminderDelivery: {
    ...studyNotifications.status,
    supportedModes: studyNotifications.supportedModes(),
  },
});
bridge.desktopQuery = (data) => core.request("/api/desktop/query", "POST", data);
bridge.desktopCommand = async (data) => {
  const result = await core.request("/api/desktop/command", "POST", data);
  // 目标保存后立即撤回旧通知；Core 在最终写入时仍做一次事务内复核。
  if (result.profile) {
    inbox.setGoal(result.profile.goal);
    if (!result.profile.planEnabled || !result.profile.reminderEnabled) studyNotifications.close();
  }
  return result;
};
bridge.dictionaryAction = (data) => textDictionary.action(data);
bridge.pronounce = (data) => pronunciation.speak(data);
bridge.audioSettings = (data) => pronunciation.settings(data);
const baseRuntime = bridge.runtime;
bridge.runtime = () => ({
  ...baseRuntime(),
  dictionary: "leximeet-dictionary 0.0.3",
  captureNotice: { mode: inbox.mode, error: inbox.error },
  pluginCaptureNotifications: pluginCaptureNotifications.snapshot(),
  plugins: connector.status().running && baseRuntime().coreConnected,
  connectorProtocolVersion: "lmcp/1.0.0",
  connector: {
    running: connector.status().running,
    error: connector.status().lastError,
  },
  dictionaryPack: textDictionary.status(),
  capabilities: {
    ...baseRuntime().capabilities,
    plugins: {
      status:
        connector.status().running && baseRuntime().coreConnected ? "available" : "not-configured",
      reason: connector.status().lastError || "本机连接需要启用浏览器通道并配对",
    },
    account: { status: "not-configured", reason: "计划在 2.0.0 接入账号" },
    cloudSync: { status: "not-configured", reason: "计划在 2.0.0 接入 LMSP" },
  },
});

const originalDesktopAction = desktop.action.bind(desktop);
desktop.action = async (payload) => {
  const result = await originalDesktopAction(payload);
  if (payload?.action === "restoreArchive" && !result?.cancelled) {
    // Core 已原子替换资料；系统许可与本机监控也必须立即收敛到恢复后的关闭状态。
    const current = await core.request("/api/settings");
    desktop.apply(current.settings);
    monitor.setEnabled(false);
  }
  if (payload?.action === "exportArchive" && !result?.cancelled)
    await core.request("/api/desktop/guide-native", "POST", {
      event: "backup",
    });
  return result;
};

function startCore() {
  if (quitting) return Promise.reject(new Error("应用正在退出，已取消核心启动"));
  ready = core.start().then(async () => {
    if (quitting) throw new Error("应用正在退出");
    monitor.mark("coreReadyMs");
    await textDictionary.ensure();
    if (quitting) throw new Error("应用正在退出，已取消词典初始化");
    const initial = await core.request("/api/settings");
    if (quitting) throw new Error("应用正在退出");
    desktop.apply(initial.settings);
    browserDiscovery.start();
    studyReminder.start();
    core
      .request("/api/desktop/query", "POST", { kind: "reminderQuestions" })
      .then((value) => {
        if (!quitting) return studyNotifications.restore(value.questions);
      })
      .catch(() => {});
    monitor.setEnabled(initial.settings.developerMonitoringEnabled);
  });
  // 保留已显示的应用壳和失败恢复入口，不用阻塞式弹窗掩盖启动失败。
  ready.catch(() => {});
  return ready;
}
function restartCore() {
  if (quitting) throw new Error("应用正在退出");
  if (!restarting)
    restarting = core
      .stop()
      .then(startCore)
      .finally(() => {
        restarting = null;
      });
  return restarting;
}

for (const method of METHODS)
  ipcMain.handle(`leximeet:${method}`, async (event, value) => {
    try {
      const win = getMainWindow();
      // file: 的 origin 为 null，因此同时校验受控窗口、顶层 frame 身份和准确文档 URL。
      if (
        !(
          win &&
          event.sender === win.webContents &&
          event.senderFrame === win.webContents.mainFrame &&
          event.senderFrame.url === sourceUrl
        ) &&
        !(method === "captureAction" && captureWindows.trusted(event))
      )
        throw new Error("拒绝未知页面的请求");
      // 备份承载整份本机事实；其他 IPC 仍维持 2 MiB，按实际 UTF-8 字节与 Core 对齐。
      const payloadBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
      if (payloadBytes > (method === "importData" ? 64 : 2) * 1024 * 1024)
        throw new Error("请求过大");
      // 状态和恢复动作必须在启动失败后仍可访问；业务请求仍等待完整核心就绪。
      if (!["runtime", "desktopAction"].includes(method)) await ready;
      return {
        ok: true,
        value:
          method === "captureAction"
            ? await captureWindows.action(value, event.sender)
            : await bridge[method](value),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

egg.register("electron-app-ready", () => {
  monitor.mark("mainReadyMs");
  // 直接复用已确认的品牌图标；不重新绘制 Logo。
  if (process.platform === "darwin" && !silentTest)
    app.dock.setIcon(path.join(projectDir, "resources/brand/icon.png"));
  // 框架在此事件之前已获得单实例锁，第二实例不会启动第二个数据库写入者。
  startCore();
  connector.start().catch(() => {
    // 状态页显示失败，不能误报已连接。
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "LexiMeet",
              submenu: [
                { role: "about" },
                { type: "separator" },
                { role: "hide" },
                { role: "quit" },
              ],
            },
          ]
        : []),
      {
        label: "编辑",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "selectAll" },
        ],
      },
      {
        label: "视图",
        submenu: [
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
        ],
      },
    ]),
  );
});
egg.register("window-ready", () => {
  monitor.mark("windowReadyMs");
  const win = getMainWindow();
  // macOS 关闭窗口仍保留应用：隐藏后由 Dock 激活恢复同一窗口。
  win.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    if (desktop.shouldHide()) win.hide();
    else app.quit();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== sourceUrl) event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  win.webContents.session.setPermissionCheckHandler(() => false);
});
function showMainWindow() {
  // OpenInDesktop 仍发送真实业务事件；测试窗口保持隐藏，避免影响本机键鼠焦点。
  if (silentTest) return;
  let win;
  try {
    win = getMainWindow();
  } catch {
    return;
  }
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
app.on("activate", showMainWindow);
app.on("second-instance", showMainWindow);
app.on("before-quit", (event) => {
  if (shutdownFinished) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  monitor.close();
  desktop.close();
  inbox.close();
  studyReminder.close();
  studyNotifications.close();
  captureWindows.close();
  pronunciation?.close();
  desktopNavigation.close();
  browserDiscovery.close();
  connectionNotifications.close();
  pluginCaptureNotifications.close();
  Promise.allSettled([connector.close(), textDictionary?.close()])
    .then(() => core.stop())
    .finally(() => {
      shutdownFinished = true;
      app.quit();
    });
});
process.on("exit", () => core.stop());
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    core.stop();
    app.quit();
  });
egg.run();
