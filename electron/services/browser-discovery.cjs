"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { browserUserDataDir } = require("./platform/app-paths.cjs");
const SUPPORTED = new Set(["darwin", "linux", "win32"]);

const EXTENSION_ID = /^[a-p]{32}$/;
const PROFILE = /^(Default|Profile [0-9]+)$/;

function readJson(file, maximum = 2 * 1024 * 1024) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maximum) return null;
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
function directories(directory, maximum) {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((item) => item.isDirectory())
      .slice(0, maximum)
      .map((item) => item.name);
  } catch {
    return [];
  }
}
function leximeetManifest(manifest) {
  // 发现只是登记传输来源，绝不等于业务授权；仍须插件用户确认邀请。
  return (
    manifest?.manifest_version === 3 &&
    manifest.name === "词遇-LexiMeet" &&
    manifest.permissions?.includes("nativeMessaging") &&
    manifest.permissions?.includes("sidePanel") &&
    manifest.background?.service_worker === "background.js" &&
    manifest.options_ui?.page === "options.html" &&
    manifest.side_panel?.default_path === "sidepanel.html"
  );
}

function registrationFailure(browser, failure) {
  const messages = {
    UNSAFE_NATIVE_REGISTRATION_DIRECTORY: "浏览器登记目录的所有者或写入权限不安全，未改变原目录。",
    UNSAFE_PRIVATE_PATH: "词遇本机通道的私有文件权限或路径异常，请检查通道配置。",
    NATIVE_REGISTRATION_NOT_OWNED: "存在不属于当前词遇安装的同名通道，原文件已保留。",
    NATIVE_REGISTRATION_CHANGED: "已有通道登记被修改，请检查或修复词遇通道。",
    ELECTRON_RUN_AS_NODE_DISABLED: "当前安装包缺少本机通道运行能力，请更新桌面端。",
    ELECTRON_FUSE_NOT_FOUND: "当前安装包的本机通道运行能力无法核验，请更新桌面端。",
    EACCES: "当前用户没有创建通道的权限，请检查浏览器登记目录。",
    EPERM: "当前用户没有创建通道的权限，请检查浏览器登记目录。",
  };
  const code = Object.hasOwn(messages, failure?.message)
    ? failure.message
    : Object.hasOwn(messages, failure?.code)
      ? failure.code
      : "NATIVE_REGISTRATION_FAILED";
  // 只公开固定分类，不把系统异常中的路径、正文或传输凭据送到界面。
  return `${browser === "chrome" ? "Chrome" : "Edge"} 通道未能自动启用：${messages[code] || "本机通道登记失败，请检查词遇安装。"} [${code}]`;
}

// 仅 local 安装扫描扩展清单；不读取浏览历史、网页内容、插件词库或账号。
class BrowserDiscovery {
  constructor({
    profile,
    homeDir,
    connectionSettings,
    platform = process.platform,
    intervalMs = 15000,
    enabled = true,
  }) {
    Object.assign(this, {
      profile,
      homeDir,
      connectionSettings,
      platform,
      intervalMs,
      enabled,
    });
    this.running = false;
    this.lastError = null;
    this.detected = [];
  }
  async scan() {
    if (!this.enabled || this.profile.name !== "local" || !SUPPORTED.has(this.platform))
      return this.snapshot();
    if (this.running) return this.snapshot();
    this.running = true;
    const next = [];
    const failures = [];
    try {
      for (const browser of ["chrome", "edge"]) {
        const root = browserUserDataDir(browser, {
          homeDir: this.homeDir,
          platform: this.platform,
        });
        const ids = new Set();
        for (const profile of directories(root, 64).filter((name) => PROFILE.test(name))) {
          const directory = path.join(root, profile);
          const settings = {
            ...(readJson(path.join(directory, "Preferences"), 16 * 1024 * 1024)?.extensions
              ?.settings || {}),
            ...(readJson(path.join(directory, "Secure Preferences"), 16 * 1024 * 1024)?.extensions
              ?.settings || {}),
          };
          for (const id of directories(path.join(directory, "Extensions"), 512).filter((id) =>
            EXTENSION_ID.test(id),
          )) {
            // Chrome 的 state=0/2 表示禁用；未记录 state 的磁盘安装仍只作为可发现候选。
            if (settings[id]?.state !== undefined && settings[id].state !== 1) continue;
            const installed = path.join(directory, "Extensions", id);
            if (
              directories(installed, 16).some((version) =>
                leximeetManifest(readJson(path.join(installed, version, "manifest.json"))),
              )
            )
              ids.add(id);
          }
          // 开发者模式的扩展路径由浏览器配置提供；只读 manifest，不扫描任意目录。
          for (const [id, metadata] of Object.entries(settings).slice(0, 512)) {
            if (
              !EXTENSION_ID.test(id) ||
              metadata?.state !== 1 ||
              !path.isAbsolute(metadata.path || "")
            )
              continue;
            if (leximeetManifest(readJson(path.join(metadata.path, "manifest.json")))) ids.add(id);
          }
        }
        if (ids.size) {
          try {
            await this.connectionSettings.registerDiscovered(browser, [...ids].sort());
            next.push({ browser, count: ids.size });
          } catch (error) {
            // 单个浏览器登记失败不能阻断另一个浏览器的正常连接。
            failures.push(registrationFailure(browser, error));
          }
        }
      }
      this.detected = next;
      this.lastError = failures.join("；") || null;
    } catch {
      // 外来 Native 注册不可覆盖；设置页提供诊断，不以探测失败打断本机学习。
      this.lastError = "浏览器通道未能自动启用，请检查插件安装或通道诊断。";
    } finally {
      this.running = false;
    }
    return this.snapshot();
  }
  start() {
    if (
      this.profile.name !== "local" ||
      !this.enabled ||
      !SUPPORTED.has(this.platform) ||
      this.timer
    )
      return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref();
  }
  snapshot() {
    return {
      supported: SUPPORTED.has(this.platform),
      isolated: this.profile.name !== "local",
      detected: [...this.detected],
      lastError: this.lastError,
    };
  }
  close() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
module.exports = { BrowserDiscovery, leximeetManifest };
