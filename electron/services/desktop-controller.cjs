const path = require("node:path");

const available = () => ({ status: "available" });
const unavailable = (reason) => ({ status: "not-configured", reason });

// 原生能力集中在 Main。网页只选择命名动作，不能传文件路径、程序或更新源。
class DesktopController {
  constructor({
    app,
    shell,
    profile,
    platform = process.platform,
    createTray,
    restartCore,
    runtime,
    showWindow,
    updater,
    capture,
    archive,
    fileBackupsEnabled = true,
  }) {
    Object.assign(this, {
      app,
      shell,
      profile,
      platform,
      createTray,
      restartCore,
      runtime,
      showWindow,
      updater,
      capture,
      archive,
      fileBackupsEnabled,
    });
    this.settings = { closeBehavior: "platform", launchAtLogin: false };
    this.tray = null;
  }
  capabilities() {
    const login =
      ["darwin", "win32"].includes(this.platform) &&
      this.app.isPackaged &&
      this.profile.name === "local";
    const updates = this.updater?.configured()
      ? available()
      : unavailable("尚未配置受信任的更新源，当前可手动安装新版本");
    return {
      localData: available(),
      dictionary: available(),
      monitoring: available(),
      restartCore: available(),
      openFolders: available(),
      fileBackups:
        this.archive && this.fileBackupsEnabled
          ? available()
          : {
              status: "unsupported",
              reason: this.fileBackupsEnabled
                ? "当前环境没有桌面文件备份能力"
                : "资料导入和导出将在后续版本开放",
            },
      tray: this.createTray
        ? available()
        : { status: "unsupported", reason: "当前环境没有系统托盘" },
      launchAtLogin: login
        ? available()
        : {
            status: "unsupported",
            reason: "仅正式安装的 macOS / Windows 应用可设置；开发和验收环境不修改系统登录项",
          },
      account: unavailable("账号服务尚未配置，本机资料可以独立使用"),
      cloudSync: unavailable("云同步尚未接入，不上传本机资料"),
      plugins: unavailable("插件配对和 LMCP 网关尚未接入"),
      updates,
      clipboardCapture: this.capture
        ? available()
        : { status: "unsupported", reason: "当前环境没有剪贴板采集" },
      globalShortcut: this.capture
        ? available()
        : { status: "unsupported", reason: "当前环境没有全局快捷键" },
      pauseUpdates: {
        status: "unsupported",
        reason: "当前更新实现不支持暂停，只能取消下载",
      },
    };
  }
  validateSettings(patch) {
    if (patch?.launchAtLogin === true && this.capabilities().launchAtLogin.status !== "available")
      throw new Error(this.capabilities().launchAtLogin.reason);
    if (patch?.closeBehavior === "hide" && this.platform !== "darwin" && !this.createTray)
      throw new Error("当前环境无法从托盘恢复窗口，不能选择隐藏");
  }
  apply(settings, { changedKeys = [] } = {}) {
    this.validateSettings(settings);
    if (settings.closeBehavior === "hide" && this.platform !== "darwin" && !this.tray)
      this.tray = this.createTray();
    if (
      changedKeys.includes("launchAtLogin") &&
      this.capabilities().launchAtLogin.status === "available"
    ) {
      this.app.setLoginItemSettings({
        openAtLogin: settings.launchAtLogin === true,
      });
      const actual = this.app.getLoginItemSettings();
      if (Boolean(actual.openAtLogin) !== (settings.launchAtLogin === true))
        throw new Error("系统登录启动状态与所选设置不一致，请检查系统设置后重试");
    }
    this.settings = { ...settings };
    this.capture?.apply(settings);
  }
  shouldHide() {
    return (
      this.settings.closeBehavior === "hide" ||
      (this.settings.closeBehavior !== "quit" && this.platform === "darwin")
    );
  }
  async action(payload) {
    if (!payload || Object.keys(payload).some((key) => !["action", "includeNotes"].includes(key)))
      throw new Error("桌面操作只接受命名 action");
    const action = payload.action;
    switch (action) {
      case "openNotificationSettings":
        if (this.platform !== "darwin") throw new Error("请在系统设置中管理通知权限");
        await this.shell.openExternal(
          "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        );
        return { ok: true, action };
      case "exportArchive":
        if (!this.fileBackupsEnabled) throw new Error(this.capabilities().fileBackups.reason);
        if (!this.archive) throw new Error("当前环境不能导出完整文件备份");
        return this.archive.export();
      case "restoreArchive":
        if (!this.fileBackupsEnabled) throw new Error(this.capabilities().fileBackups.reason);
        if (!this.archive) throw new Error("当前环境不能恢复完整文件备份");
        return this.archive.restore();
      case "restartCore":
        await this.restartCore();
        return { ok: true, action, runtime: this.runtime() };
      case "showDataFolder":
      case "showLogsFolder": {
        const location =
          action === "showDataFolder" ? this.profile.root : path.join(this.profile.root, "logs");
        const error = await this.shell.openPath(location);
        if (error) throw new Error("系统无法打开本机目录");
        return { ok: true, action };
      }
      case "checkForUpdates": {
        if (!this.updater)
          return {
            ok: true,
            action,
            message: this.capabilities().updates.reason,
            runtime: this.runtime(),
          };
        const result = await this.updater.check();
        return {
          ok: true,
          action,
          ...result,
          message:
            result.reason ||
            (result.status === "available"
              ? `发现 ${result.version}`
              : result.status === "up-to-date"
                ? "已是当前版本"
                : result.reason),
          runtime: this.runtime(),
        };
      }
      case "downloadUpdate": {
        if (!this.updater?.configured()) throw new Error(this.capabilities().updates.reason);
        const result = await this.updater.download();
        return { ok: true, action, ...result };
      }
      case "cancelUpdate":
        this.updater?.inflight?.abort();
        return { ok: true, action, message: "已请求取消下载" };
      default:
        throw new Error("不支持的桌面操作");
    }
  }
  close() {
    this.tray?.destroy();
    this.tray = null;
    this.capture?.close();
    this.updater?.close();
  }
}
module.exports = { DesktopController };
