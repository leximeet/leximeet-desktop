"use strict";
const { NOTIFICATION_ICON } = require("./notification-icon.cjs");

// 系统通知只展示设备名与明确用户操作，不包含配对凭据、账号或资料。
class ConnectionNotifications {
  constructor({ Notification, gateway, changed = () => {} }) {
    Object.assign(this, { Notification, gateway, changed });
    this.discovered = new Set();
    this.discovering = new Set();
    this.connected = new Set();
    this.notices = new Map();
    this.lastError = null;
    this.closed = false;
  }
  async discover(client) {
    if (this.closed || !client.clientInstanceId) return;
    const key = `${client.origin}:${client.clientInstanceId}`;
    if (this.discovered.has(key) || this.discovering.has(key)) return;
    this.discovering.add(key);
    let state;
    try {
      state = await this.gateway.manage({ action: "state" });
    } finally {
      this.discovering.delete(key);
    }
    if (this.closed) return;
    this.discovered.add(key);
    if (this.discovered.size > 64) this.discovered.delete(this.discovered.values().next().value);
    const pairing = (state.clients || []).find(
      (item) =>
        item.clientInstanceId === client.clientInstanceId &&
        item.origin?.replace(/\/$/, "") === client.origin.replace(/\/$/, "") &&
        !item.revoked,
    );
    if (pairing?.connectionState === "connected") return;
    this.issue(
      `discovered:${key}`,
      "发现词遇浏览器插件",
      "点击发送连接邀请，在浏览器确认后即可使用桌面词库。",
      async () => {
        await this.gateway.manage({
          action: "requestConnection",
          clientInstanceId: client.clientInstanceId,
          origin: client.origin,
        });
        this.changed();
      },
    );
  }
  connectionReady(client) {
    if (this.closed || !client.owner?.pairingId) return;
    const key = `${client.owner.pairingId}:${client.owner.authorizationEpoch}`;
    if (this.connected.has(key)) return;
    this.connected.add(key);
    this.issue(
      `connected:${key}`,
      "插件连接成功",
      "网页查词与采集已使用这台桌面端。两端均可断开连接。",
    );
    this.changed();
  }
  issue(id, title, body, action) {
    if (this.closed) return;
    if (!this.Notification?.isSupported?.()) {
      this.lastError = "系统通知不可用，可在插件连接设置中操作。";
      return;
    }
    let notice;
    try {
      notice = new this.Notification({
        icon: NOTIFICATION_ICON,
        title,
        body,
        silent: true,
      });
    } catch {
      this.lastError = "系统通知未显示，可在插件连接设置中操作。";
      this.changed();
      return;
    }
    this.notices.set(id, notice);
    notice.on("failed", () => {
      this.lastError = "系统通知未显示，请允许词遇通知；插件连接设置仍可使用。";
      this.changed();
    });
    notice.on("close", () => this.notices.delete(id));
    notice.once("click", () => {
      if (this.closed || !action) return;
      Promise.resolve()
        .then(action)
        .catch(() => {
          this.lastError = "连接邀请未发送，请在插件连接设置中重试。";
          this.changed();
        });
    });
    try {
      notice.show();
    } catch {
      this.lastError = "系统通知未显示，可在插件连接设置中操作。";
      this.changed();
    }
  }
  snapshot() {
    return { lastError: this.lastError };
  }
  close() {
    this.closed = true;
    for (const notice of this.notices.values()) notice.close();
    this.notices.clear();
  }
}
module.exports = { ConnectionNotifications };
