"use strict";
const { NOTIFICATION_ICON } = require("./notification-icon.cjs");
const { randomUUID } = require("node:crypto");

// 一次复制只为目标命中词建立独立决策。Core 判定成员，Main 管理通知、计时和撤回。
class ClipboardInbox {
  constructor({
    Notification,
    match,
    save,
    changed,
    fallback,
    now = Date.now,
    timeoutMs = 10000,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    Object.assign(this, {
      Notification,
      match,
      save,
      changed,
      fallback,
      now,
      timeoutMs,
      setTimer,
      clearTimer,
    });
    this.items = new Map();
    this.enabled = false;
    this.autoCollect = true;
    this.mode = "system";
    this.queue = Promise.resolve();
    this.generation = 0;
    this.error = "";
    this.goal = null;
  }
  apply(settings) {
    const mode = settings.clipboardReminderMode === "popup" ? "popup" : "system";
    if (mode !== this.mode) this.cancel();
    this.mode = mode;
    this.autoCollect = settings.clipboardAutoCollect !== false;
    this.enabled = settings.clipboardCaptureEnabled === true;
    if (!this.enabled) this.cancel();
  }
  // 目标变更撤回已展示的通知，同时废弃仍在等待 Core 的匹配结果。
  setGoal(goal) {
    const next = goal || "";
    if (this.goal === next) return;
    this.goal = next;
    this.cancel();
  }
  async accept({ text, words }) {
    if (!this.enabled) return;
    const generation = this.generation;
    let result;
    try {
      // 匹配失败时保持静默采集边界，绝不退回“所有英文词都通知”。
      result = await this.match(words, text);
    } catch {
      if (this.enabled && generation === this.generation) {
        this.error = "学习目标匹配失败，本次没有采集。请在设置中点击重试采集。";
        this.publish();
      }
      return;
    }
    if (!this.enabled || generation !== this.generation) return;
    // 启动后的首次匹配只建立已知目标，不取消同时复制、仍在匹配的同目标文本。
    if (this.goal === null) this.goal = result.goal || "";
    else this.setGoal(result.goal);
    if (!result.goal) return;
    if (![...this.items.values()].some((item) => item.status === "failed")) this.error = "";
    for (const { word, wordId, context = text, captureStatus } of result.matches) {
      // Core 已按目标、句子、脱敏和窗口筛选。正在决策的同一安全句子也只提示一次。
      if (
        captureStatus === "duplicate-context" ||
        [...this.items.values()].some(
          (item) =>
            ["pending", "saving", "failed"].includes(item.status) &&
            item.wordId === wordId &&
            item.context === context,
        )
      )
        continue;
      const id = randomUUID();
      const item = {
        id,
        word,
        wordId,
        goal: result.goal,
        context,
        status: "pending",
        expiresAt: 0,
        autoCollect: this.autoCollect,
        timer: null,
        guard: null,
        notification: null,
      };
      this.items.set(id, item);
      if (this.mode === "popup") {
        item.fallback = true;
        this.fallback();
        continue;
      }
      try {
        if (!this.Notification?.isSupported()) throw new Error("系统通知不可用");
        const notification = new this.Notification({
          icon: NOTIFICATION_ICON,
          title: `保存 ${word} 的语境？`,
          body: item.autoCollect
            ? "10 秒后自动采集，可选择不采集。"
            : "10 秒后不采集，可立即采集。",
          silent: true,
          timeoutType: "never",
          closeButtonText: "不采集",
          actions: [
            { type: "button", text: "采集" },
            { type: "button", text: "不采集" },
          ],
        });
        item.notification = notification;
        notification.on("show", () => {
          if (!item.fallback) this.arm(id);
        });
        notification.on("click", () => this.decide(id, true));
        notification.on("action", (event, legacyIndex) => {
          const index = event?.actionIndex ?? legacyIndex;
          if (index === 0 || index === 1) this.decide(id, index === 0);
        });
        // 程序主动 close 前先改变状态。Windows 系统超时不是用户拒绝。
        notification.on("close", (event) => {
          if (
            item.status === "pending" &&
            !item.nativeWithdrawn &&
            event?.reason !== "timedOut" &&
            event?.reason !== "applicationHidden"
          )
            this.decide(id, false);
        });
        notification.on("failed", () => this.notificationFailed(item));
        item.guard = this.setTimer(() => {
          if (!item.expiresAt) this.notificationFailed(item);
        }, 30000);
        notification.show();
      } catch {
        this.notificationFailed(item);
      }
    }
    this.publish();
  }
  notificationFailed(item) {
    if (item.status !== "pending") return;
    item.status = "failed";
    item.expiresAt = 0;
    item.deliveryFailed = true;
    this.clearTimer(item.timer);
    this.clearTimer(item.guard);
    item.nativeWithdrawn = true;
    item.notification?.close();
    this.error = "系统通知未送达，本次没有自动采集。请在设置中点击重试采集，或检查系统通知权限。";
    // 不把失败变成弹窗，也不在没有显示通知时开始采集倒计时。
    this.publish();
  }
  // 失败没有倒计时。用户点击通知才恢复原操作，不能把响应丢失当成一个新操作。
  notifyRetry(item) {
    if (!this.enabled || this.items.get(item.id) !== item || item.status !== "failed") return;
    item.nativeWithdrawn = true;
    item.notification?.close();
    try {
      if (!this.Notification?.isSupported()) throw new Error("系统通知不可用");
      const notification = new this.Notification({
        icon: NOTIFICATION_ICON,
        title: `${item.word} · 采集结果待确认`,
        body: "点击重试确认原采集结果；不会重复保存。",
        silent: true,
        timeoutType: "never",
        closeButtonText: "关闭提示",
        actions: [
          { type: "button", text: "重试采集" },
          { type: "button", text: "关闭提示" },
        ],
      });
      item.notification = notification;
      item.nativeWithdrawn = false;
      notification.on("show", () => {
        if (item.notification === notification) item.deliveryFailed = false;
      });
      notification.on("click", () => this.decide(item.id, true));
      notification.on("action", (event, legacyIndex) => {
        const index = event?.actionIndex ?? legacyIndex;
        if (index === 0 || index === 1) this.decide(item.id, index === 0);
      });
      notification.on("close", (event) => {
        if (
          item.status === "failed" &&
          item.notification === notification &&
          !item.nativeWithdrawn &&
          event?.reason !== "timedOut" &&
          event?.reason !== "applicationHidden"
        )
          this.decide(item.id, false);
      });
      notification.on("failed", () => {
        if (item.notification === notification && item.status === "failed") {
          item.deliveryFailed = true;
          this.error = "重试通知未送达，请在设置中点击重试采集查看待处理项。";
          this.publish();
        }
      });
      // 静默失败也保留恢复入口；只有本次通知的真实 show 能标记为已送达。
      item.deliveryFailed = true;
      notification.show();
    } catch {
      item.deliveryFailed = true;
      this.error = "重试通知未送达，请在设置中点击重试采集查看待处理项。";
    }
  }
  // 仅由主窗的显式重试调用；重发确认通知，不读取正文、不自动写入。
  retryFailedNotifications() {
    if (this.mode === "system")
      for (const item of this.items.values()) if (item.status === "failed") this.notifyRetry(item);
    this.publish();
  }
  ready() {
    for (const item of this.items.values()) if (item.fallback) this.arm(item.id);
  }
  arm(id) {
    const item = this.items.get(id);
    if (!item || item.status !== "pending" || item.expiresAt) return;
    this.clearTimer(item.guard);
    item.expiresAt = this.now() + this.timeoutMs;
    item.timer = this.setTimer(() => this.decide(id, item.autoCollect), this.timeoutMs);
    this.publish();
  }
  async decide(id, collect) {
    const item = this.items.get(id);
    if (!this.enabled || !item || !["pending", "failed"].includes(item.status)) return false;
    item.status = collect ? "saving" : "dismissed";
    this.clearTimer(item.timer);
    this.clearTimer(item.guard);
    item.nativeWithdrawn = true;
    item.notification?.close();
    item.expiresAt = 0;
    if (!collect) {
      this.items.delete(id);
      if (![...this.items.values()].some((item) => item.status === "failed")) this.error = "";
      this.publish();
      return true;
    }
    const generation = this.generation;
    const pending = this.queue
      .catch(() => {})
      .then(async () => {
        if (!this.enabled || generation !== this.generation) return;
        await this.save({
          action: "captureClipboard",
          goal: item.goal,
          wordId: item.wordId,
          context: item.context,
          operationId: item.id,
        });
      });
    this.queue = pending;
    this.publish();
    try {
      await pending;
      this.items.delete(id);
      if (
        generation === this.generation &&
        ![...this.items.values()].some((item) => item.status === "failed")
      )
        this.error = "";
    } catch (error) {
      // 目标变更或退出后，迟到失败不能重新创建提示、抢出窗口或覆盖新一轮状态。
      if (!this.enabled || generation !== this.generation || this.items.get(id) !== item)
        return true;
      item.status = "failed";
      this.error = `采集 ${item.word} 失败：${error.message}`;
      if (this.mode === "popup") this.fallback();
      else this.notifyRetry(item);
    }
    this.publish();
    return true;
  }
  cancel() {
    this.generation = (this.generation || 0) + 1;
    for (const item of this.items.values()) {
      item.status = "dismissed";
      this.clearTimer(item.timer);
      this.clearTimer(item.guard);
      item.notification?.close();
    }
    this.items.clear();
    this.error = "";
    this.publish();
  }
  snapshot() {
    return {
      items: [...this.items.values()].map(
        ({ id, word, context, status, expiresAt, autoCollect }) => ({
          id,
          word,
          context,
          status,
          expiresAt,
          autoCollect,
        }),
      ),
      error: this.error,
      reminderMode: this.mode,
      deliveryRetryRequired: [...this.items.values()].some(
        (item) => item.status === "failed" && item.deliveryFailed,
      ),
    };
  }
  publish() {
    this.changed?.(this.snapshot());
  }
  close() {
    this.enabled = false;
    this.cancel();
  }
}
module.exports = { ClipboardInbox };
