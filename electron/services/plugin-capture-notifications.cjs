"use strict";
const { NOTIFICATION_ICON } = require("./notification-icon.cjs");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { readPrivateJson, writePrivateJson } = require("./lmcp/private-files.cjs");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const text = (value, maximum) =>
  String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);

/**
 * 只消费 Core 已提交的插件采集回执。通知失败不改变采集结果，也不打开或聚焦窗口。
 * 按工作区、代次、遇见事件去重；近期回执哈希持久保存，ACK 丢失和重启后重试不重复提醒。
 * 这是设备上的通知缓存，不是业务数据；不保存原文、网址、认证凭据或单词内容。
 */
class PluginCaptureNotifications {
  constructor({ Notification, profile, settings, changed = () => {}, maximumReceipts = 4096 }) {
    Object.assign(this, { Notification, settings, changed, maximumReceipts });
    this.file = path.join(profile.root, "notifications", "plugin-capture-receipts.json");
    this.seen = new Set();
    this.notices = new Set();
    this.queue = Promise.resolve();
    this.closed = false;
    this.sentCount = 0;
    this.lastError = null;
    try {
      if (fs.existsSync(this.file)) {
        const value = readPrivateJson(this.file, { maximumBytes: 400000 });
        if (
          value.version !== 1 ||
          !Array.isArray(value.receipts) ||
          value.receipts.length > maximumReceipts ||
          value.receipts.some((key) => !/^[0-9a-f]{64}$/.test(key))
        )
          throw new Error("INVALID_NOTIFICATION_CACHE");
        this.seen = new Set(value.receipts);
      }
    } catch {
      // 无效文件保留原样，不覆盖或把损坏的缓存当成已通知。
      this.cacheInvalid = true;
      this.lastError = "采集通知缓存无法读取；采集资料仍已保存。";
    }
  }
  captureCommitted(commit) {
    const run = this.queue.then(() => this.deliver(commit));
    this.queue = run.catch(() => {
      this.lastError = "插件采集通知未发送；采集资料仍已保存。";
      this.changed();
    });
    return this.queue;
  }
  async deliver(commit) {
    if (
      this.closed ||
      commit?.captureStatus === "duplicate-context" ||
      !UUID.test(commit?.eventId || "") ||
      !UUID.test(commit?.workspaceId || "") ||
      !UUID.test(commit?.generation || "")
    )
      return;
    const key = createHash("sha256")
      .update(`${commit.workspaceId}:${commit.generation}:${commit.eventId}`)
      .digest("hex");
    if (this.seen.has(key)) return;
    const settings = await this.settings();
    if (this.closed) return;
    this.seen.add(key);
    while (this.seen.size > this.maximumReceipts) this.seen.delete(this.seen.values().next().value);
    if (!this.cacheInvalid) writePrivateJson(this.file, { version: 1, receipts: [...this.seen] });
    // 关闭期间的成功采集也已消费；重新打开开关不补发这些旧通知。
    if (settings.pluginCaptureNotificationsEnabled === false) return;
    if (!this.Notification?.isSupported?.()) {
      this.lastError = "系统通知不可用；插件采集资料仍已保存。";
      this.changed();
      return;
    }
    const plugin = text(commit.pluginName, 60) || "插件";
    const word = text(commit.word, 80);
    const notice = new this.Notification({
      icon: NOTIFICATION_ICON,
      title: "插件采集成功",
      body: word ? `${plugin}已保存“${word}”的遇见。` : `${plugin}已保存一次遇见。`,
      silent: true,
    });
    this.notices.add(notice);
    // 限制 Main 持有的系统通知对象；系统关闭后也立即释放。
    while (this.notices.size > 16) {
      const previous = this.notices.values().next().value;
      this.notices.delete(previous);
      previous.close();
    }
    notice.once("show", () => {
      if (this.closed) return;
      this.sentCount++;
      this.lastError = null;
      this.changed();
    });
    notice.once("failed", () => {
      this.lastError = "插件采集通知未显示，请在系统设置中允许词遇通知。资料已保存。";
      this.changed();
    });
    notice.once("close", () => this.notices.delete(notice));
    notice.show();
  }
  snapshot() {
    return { sentCount: this.sentCount, lastError: this.lastError };
  }
  close() {
    this.closed = true;
    for (const notice of this.notices) notice.close();
    this.notices.clear();
  }
}
module.exports = { PluginCaptureNotifications };
