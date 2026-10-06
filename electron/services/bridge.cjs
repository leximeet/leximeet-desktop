const { DeveloperMonitor } = require("./developer-monitor.cjs");

const METHODS = Object.freeze([
  "captureAction",
  "desktopState",
  "desktopQuery",
  "desktopCommand",
  "dictionaryAction",
  "pronounce",
  "audioSettings",
  "snapshot",
  "settings",
  "cardLayout",
  "exportData",
  "importData",
  "runtime",
  "openExternal",
  "diagnostics",
  "desktopAction",
  "connectionSettings",
]);
function safeExternalUrl(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("无效来源链接");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("只支持 HTTP / HTTPS 来源链接");
  return url.href;
}

// 按业务动作暴露能力，renderer 无法传入 API 路径、磁盘路径、端口或命令。
function createBridge({
  core,
  profile,
  openExternal = async () => {},
  versions = {},
  monitor = new DeveloperMonitor(),
  desktop,
  appInfo = {},
  textDictionary,
  pronunciation,
}) {
  const request = (...args) => core.request(...args);
  const applySettings = (settings, options) => {
    desktop?.apply(settings, options);
    monitor.setEnabled(settings?.developerMonitoringEnabled);
  };
  let settingsQueue = Promise.resolve();
  const changeSettings = (action) => {
    // 设置与导入共享提交顺序，保证 DB 状态、采集器与系统策略按同一顺序生效。
    const pending = settingsQueue.then(action);
    settingsQueue = pending.catch(() => {});
    return pending;
  };
  const bridge = {
    captureAction: () => {
      throw new Error("当前环境没有独立采集窗口");
    },
    desktopState: () => request("/api/desktop/state"),
    desktopQuery: (data) => request("/api/desktop/query", "POST", data),
    desktopCommand: (data) => request("/api/desktop/command", "POST", data),
    dictionaryAction: (data) => {
      if (!textDictionary) throw new Error("当前环境尚未装配公共词典");
      return textDictionary.action(data);
    },
    pronounce: (data) => {
      if (!pronunciation) throw new Error("当前环境尚未装配发音服务");
      return pronunciation.speak(data);
    },
    audioSettings: (data) => {
      if (!pronunciation) throw new Error("当前环境尚未装配发音服务");
      return pronunciation.settings(data);
    },
    // 快照是只读动作，旧响应绝不能重新应用监控/登录项设置。
    snapshot: async () => {
      const value = await request("/api/snapshot");
      monitor.mark("firstSnapshotMs");
      return value;
    },
    settings: (data) =>
      changeSettings(async () => {
        desktop?.validateSettings(data);
        // 以 Core 为权威读取完整旧设置；多字段提交失败时，隐私授权也必须一并恢复。
        const previous = desktop ? (await request("/api/settings")).settings : null;
        const value = await request("/api/settings", "PATCH", data);
        try {
          applySettings(value.settings, {
            changedKeys: Object.keys(data || {}),
          });
        } catch (error) {
          // 系统调用不能加入 SQLite 事务，因此在同一单写队列内执行完整补偿。
          if (previous) {
            try {
              // 词卡有独立修订号，原生设置补偿只恢复普通字段，不能绕过其并发保护。
              const ordinary = Object.fromEntries(
                Object.entries(previous).filter(([key]) => key !== "cardLayout"),
              );
              const restored = await request("/api/settings", "PATCH", ordinary);
              applySettings(restored.settings, {
                changedKeys: Object.hasOwn(data || {}, "launchAtLogin") ? ["launchAtLogin"] : [],
              });
            } catch (restoreError) {
              // 补偿也失败时只读回能确认的 Core 状态，明确告知系统策略仍待核对。
              try {
                monitor.setEnabled(
                  (await request("/api/settings")).settings.developerMonitoringEnabled,
                );
              } catch {
                // 核心不可达，保留当前状态供恢复入口处理。
              }
              throw new Error(
                `设置保存失败，恢复也未完成：${restoreError.message}。请刷新本机状态后重试。`,
              );
            }
          }
          throw error;
        }
        return value;
      }),
    cardLayout: (data) => changeSettings(() => request("/api/card-layout", "PUT", data)),
    exportData: () => request("/api/export"),
    importData: (data) =>
      changeSettings(async () => {
        const value = await request("/api/import", "POST", data);
        applySettings(value.settings);
        return value;
      }),
    runtime: () => ({
      profile: profile.name,
      dataDir: profile.root,
      databasePath: `${profile.coreDir}/leximeet.sqlite`,
      coreConnected: Boolean(core.port) && (!core.state || core.state === "ready"),
      coreState: core.state || (core.port ? "ready" : "stopped"),
      coreError: core.lastError || null,
      protocolVersion: "1",
      framework: "Electron Egg 5.0.1",
      versions,
      dictionary: "leximeet-dictionary 0.0.3",
      cloud: false,
      plugins: false,
      connectorProtocolVersion: "lmcp/1.0.0",
      app: {
        name: "LexiMeet",
        platform: process.platform,
        packaged: false,
        ...appInfo,
      },
      startup: { ...monitor.startup },
      capabilities: {
        ...(desktop?.capabilities() || {
          localData: { status: "available" },
          dictionary: { status: "available" },
          monitoring: { status: "available" },
          restartCore: { status: "unsupported" },
          openFolders: { status: "unsupported" },
          tray: { status: "unsupported" },
          launchAtLogin: { status: "unsupported" },
          account: { status: "not-configured" },
          cloudSync: { status: "not-configured" },
          plugins: { status: "not-configured" },
          updates: {
            status: "not-configured",
            reason: "尚未配置受信任的更新源",
          },
        }),
      },
    }),
    openExternal: (url) => openExternal(safeExternalUrl(url)),
    diagnostics: async () => {
      if (!monitor.enabled) return { enabled: false };
      const generation = monitor.generation;
      const coreMetrics = await request("/api/diagnostics");
      // 关闭发生在请求途中时，不能把先前采样重新显示到界面。
      if (generation !== monitor.generation) return { enabled: false };
      if (!monitor.enabled || coreMetrics.enabled !== true) {
        monitor.setEnabled(false);
        return { enabled: false };
      }
      return { ...monitor.snapshot(), core: coreMetrics };
    },
    desktopAction: (payload) => {
      if (!desktop) throw new Error("浏览器验收环境不提供此原生桌面操作");
      // 文件恢复与设置/JSON 合并共用提交顺序，避免旧授权设置在恢复后迟到生效。
      if (payload?.action === "restoreArchive")
        return changeSettings(() => desktop.action(payload));
      return desktop.action(payload);
    },
    connectionSettings: () => {
      throw new Error("插件连接设置需要原生桌面环境");
    },
  };
  for (const method of METHODS) {
    if (["runtime", "diagnostics"].includes(method)) continue;
    const action = bridge[method];
    bridge[method] = (...args) => monitor.measure(method, () => action(...args));
  }
  return bridge;
}
module.exports = { createBridge, METHODS, safeExternalUrl };
