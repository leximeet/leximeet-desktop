"use strict";
const fs = require("node:fs");
const path = require("node:path");

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
    if (!this.enabled || this.profile.name !== "local" || this.platform !== "darwin")
      return this.snapshot();
    if (this.running) return this.snapshot();
    this.running = true;
    const next = [];
    try {
      for (const [browser, relative] of [
        ["chrome", "Google/Chrome"],
        ["edge", "Microsoft Edge"],
      ]) {
        const root = path.join(this.homeDir, "Library", "Application Support", relative);
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
          await this.connectionSettings.registerDiscovered(browser, [...ids].sort());
          next.push({ browser, count: ids.size });
        }
      }
      this.detected = next;
      this.lastError = null;
    } catch {
      // 外来 Native 注册不可覆盖；设置页提供诊断，不以探测失败打断本机学习。
      this.lastError = "浏览器通道未能自动启用，请检查插件安装或通道诊断。";
    } finally {
      this.running = false;
    }
    return this.snapshot();
  }
  start() {
    if (this.profile.name !== "local" || !this.enabled || this.platform !== "darwin" || this.timer)
      return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.intervalMs);
    this.timer.unref();
  }
  snapshot() {
    return {
      supported: this.platform === "darwin",
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
