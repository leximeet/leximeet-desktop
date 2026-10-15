"use strict";
const path = require("node:path");
const os = require("node:os");

/**
 * 资料、MCP 指针和浏览器 User Data 按平台落到与 Electron appData 一致的根。
 * 测试可注入 homeDir / appData，避免误用本机 APPDATA。
 */
function homeOf(homeDir = os.homedir()) {
  if (!path.isAbsolute(homeDir || "")) throw new Error("HOME_MUST_BE_ABSOLUTE");
  return homeDir;
}

function appDataRoot({ homeDir = os.homedir(), platform = process.platform, appData, env } = {}) {
  const home = homeOf(homeDir);
  const environment = env || process.env;
  // 注入的隔离 home 默认写到该 home 下，避免测试误用本机 APPDATA / XDG_CONFIG_HOME。
  // 显式 appData，或调用方传入的 env 覆盖，仍优先。
  const isolated = path.resolve(home) !== path.resolve(os.homedir());
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "LexiMeet");
  if (platform === "win32") {
    const roaming =
      appData ||
      (isolated ? env?.APPDATA : environment.APPDATA) ||
      path.join(home, "AppData", "Roaming");
    return path.join(roaming, "LexiMeet");
  }
  const config =
    (isolated ? env?.XDG_CONFIG_HOME : environment.XDG_CONFIG_HOME) || path.join(home, ".config");
  return path.join(config, "LexiMeet");
}

function mcpDir(options) {
  return path.join(appDataRoot(options), "mcp");
}

function mcpPointerPath(options) {
  return path.join(mcpDir(options), "current.json");
}

function mcpLauncherPath(options = {}) {
  const platform = options.platform || process.platform;
  return path.join(mcpDir(options), platform === "win32" ? "leximeet-mcp.exe" : "leximeet-mcp");
}

function localAppData({
  homeDir = os.homedir(),
  platform = process.platform,
  env = process.env,
} = {}) {
  const home = homeOf(homeDir);
  if (platform === "win32") return env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  return home;
}

/** Chrome / Edge 用户资料根（只读 Preferences，不写浏览历史）。 */
function browserUserDataDir(browser, options = {}) {
  const platform = options.platform || process.platform;
  const home = homeOf(options.homeDir);
  if (!["chrome", "edge"].includes(browser)) throw new Error("UNSUPPORTED_BROWSER");
  if (platform === "darwin") {
    return path.join(
      home,
      "Library",
      "Application Support",
      browser === "chrome" ? "Google/Chrome" : "Microsoft Edge",
    );
  }
  if (platform === "win32") {
    const local = localAppData(options);
    return path.join(
      local,
      browser === "chrome" ? "Google/Chrome/User Data" : "Microsoft/Edge/User Data",
    );
  }
  return path.join(
    options.env?.XDG_CONFIG_HOME || path.join(home, ".config"),
    browser === "chrome" ? "google-chrome" : "microsoft-edge",
  );
}

/** Native Messaging 清单目录（Windows 走注册表，此路径仅作 Linux/macOS 文件落点）。 */
function nativeMessagingHostsDir(browser, options = {}) {
  const platform = options.platform || process.platform;
  const root = browserUserDataDir(browser, options);
  if (platform === "win32") return root;
  return path.join(root, "NativeMessagingHosts");
}

function xdgAutostartDir(options = {}) {
  const home = homeOf(options.homeDir);
  const config = options.env?.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(config, "autostart");
}

module.exports = {
  homeOf,
  appDataRoot,
  mcpDir,
  mcpPointerPath,
  mcpLauncherPath,
  browserUserDataDir,
  nativeMessagingHostsDir,
  xdgAutostartDir,
  localAppData,
};
