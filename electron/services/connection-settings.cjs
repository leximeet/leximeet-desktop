"use strict";
const path = require("node:path");
const {
  registerNativeHost,
  assertRegistrationOwnership,
} = require("./lmcp/native-registration.cjs");
const { browserUserDataDir } = require("./platform/app-paths.cjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SUPPORTED = new Set(["darwin", "linux", "win32"]);

// 设置页仅提交用户意图。目录、可执行文件、来源白名单由 Main 决定。
class ConnectionSettings {
  constructor({
    gateway,
    profile,
    electronExecutable,
    hostScript,
    homeDir,
    platform = process.platform,
    register = registerNativeHost,
    discoveryStatus = () => null,
  }) {
    Object.assign(this, {
      gateway,
      profile,
      electronExecutable,
      hostScript,
      homeDir,
      platform,
      register,
      discoveryStatus,
    });
    this.discoveredRegistrations = new Map();
  }
  async action(input = { action: "state" }) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("连接设置参数无效");
    const fields = {
      state: ["action"],
      requestConnection: ["action", "clientInstanceId", "origin"],
      cancelInvitation: ["action", "invitationId"],
      revoke: ["action", "clientInstanceId"],
      disconnect: ["action", "clientInstanceId"],
      registerHost: ["action", "browser", "extensionId"],
    }[input.action];
    if (!fields || Object.keys(input).some((key) => !fields.includes(key)))
      throw new Error("不支持的连接设置操作");
    if (
      ["revoke", "disconnect", "requestConnection"].includes(input.action) &&
      !UUID.test(input.clientInstanceId || "")
    )
      throw new Error("请选择有效的已配对设备");
    if (
      input.action === "requestConnection" &&
      input.origin !== undefined &&
      !/^chrome-extension:\/\/[a-p]{32}\/?$/.test(input.origin)
    )
      throw new Error("插件来源无效");
    if (input.action === "cancelInvitation" && !UUID.test(input.invitationId || ""))
      throw new Error("请选择有效的连接邀请");
    if (input.action === "registerHost") {
      if (
        !["chrome", "edge"].includes(input.browser) ||
        !/^[a-p]{32}$/.test(input.extensionId || "")
      )
        throw new Error("请选择浏览器并填写有效的插件 ID");
      if (!SUPPORTED.has(this.platform))
        throw new Error("当前平台尚未提供本机 Native Messaging 注册");
      const isolated = this.profile.name !== "local";
      const browserDataDir = isolated
        ? path.join(this.profile.root, "browser-profile", input.browser)
        : browserUserDataDir(input.browser, { homeDir: this.homeDir, platform: this.platform });
      this.register({
        extensionId: input.extensionId,
        browserDataDir,
        profileRoot: this.profile.root,
        electronExecutable: this.electronExecutable,
        hostScript: this.hostScript,
        platform: this.platform,
        profileName: this.profile.name,
        isolated,
        allowDailyRegistration: !isolated,
        browser: input.browser,
      });
      await this.gateway.refreshRegistrations();
      // UI 不读取启动器内容或传输密钥，注册路径只在使用说明中诊断。
      return {
        registered: true,
        browser: input.browser,
        extensionId: input.extensionId,
        isolated,
      };
    }
    // Core 发现状态使用无尾斜杠的来源；兼容 Native 传入的尾斜杠，只归一化精确来源。
    const command =
      input.action === "requestConnection" && input.origin !== undefined
        ? { ...input, origin: input.origin.replace(/\/$/, "") }
        : input;
    const result = await this.gateway.manage(command);
    if (input.action !== "state") return result;
    const status = this.gateway.status();
    return {
      ...result,
      transport: {
        running: status.running,
        lastError: status.lastError,
        connections: status.connections,
      },
      registration: {
        supported: SUPPORTED.has(this.platform),
        isolated: this.profile.name !== "local",
      },
      discovery: this.discoveryStatus(),
    };
  }
  // Main 的安装发现器调用，不允许 Renderer 自选日常目录或批量来源。
  async registerDiscovered(browser, extensionIds) {
    if (
      this.profile.name !== "local" ||
      !SUPPORTED.has(this.platform) ||
      !["chrome", "edge"].includes(browser) ||
      !Array.isArray(extensionIds) ||
      !extensionIds.length ||
      extensionIds.some((id) => !/^[a-p]{32}$/.test(id))
    )
      throw new Error("自动发现注册参数无效");
    const signature = extensionIds.join(",");
    const cached = this.discoveredRegistrations.get(browser);
    if (cached?.signature === signature) {
      // 周期探测只校验小型自有记录，不反复扫描大体积 Electron fuse 或重写浏览器注册。
      assertRegistrationOwnership(cached.registration);
      return;
    }
    const registration = this.register({
      extensionIds,
      browserDataDir: browserUserDataDir(browser, {
        homeDir: this.homeDir,
        platform: this.platform,
      }),
      browser,
      profileRoot: this.profile.root,
      electronExecutable: this.electronExecutable,
      hostScript: this.hostScript,
      platform: this.platform,
      profileName: "local",
      isolated: false,
      allowDailyRegistration: true,
    });
    this.discoveredRegistrations.set(browser, { signature, registration });
    await this.gateway.refreshRegistrations();
  }
}
module.exports = { ConnectionSettings };
