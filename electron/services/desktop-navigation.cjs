"use strict";
const { randomUUID } = require("node:crypto");

const PAGES = Object.freeze({
  word: "library",
  library: "library",
  plan: "plan",
  settings: "settings",
});

// 连接端只请求固定页面。收到 Renderer 的路由确认后，才把动作记成已打开。
class DesktopNavigation {
  constructor({ getWindow, showWindow, timeoutMs = 3000 }) {
    Object.assign(this, { getWindow, showWindow, timeoutMs });
    this.pending = new Map();
  }

  async open(params, result) {
    const delivery = result?.navigationDelivery;
    const page = PAGES[delivery?.target];
    if (!page || delivery.target !== params?.target) return false;
    let win;
    try {
      win = this.getWindow();
    } catch {
      return false;
    }
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return false;
    if (
      delivery.target === "word" &&
      (typeof delivery.uiWordId !== "string" ||
        !delivery.uiWordId ||
        delivery.uiWordId.length > 120 ||
        typeof delivery.uiSearchTerm !== "string" ||
        !delivery.uiSearchTerm ||
        delivery.uiSearchTerm.length > 200)
    )
      return false;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      const finish = (opened) => {
        const entry = this.pending.get(requestId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        resolve(opened === true);
      };
      const timer = setTimeout(() => finish(false), this.timeoutMs);
      this.pending.set(requestId, { sender: win.webContents, finish, timer });
      try {
        this.showWindow();
        win.webContents.send("leximeet:navigate", {
          requestId,
          page,
          ...(delivery.target === "word"
            ? {
                wordId: delivery.uiWordId,
                searchTerm: delivery.uiSearchTerm,
                scope: params.word?.kind === "dictionary" ? "dictionary" : "library",
              }
            : {}),
        });
      } catch {
        finish(false);
      }
    });
  }

  acknowledge(event, value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).some((key) => !["requestId", "opened"].includes(key)) ||
      typeof value.opened !== "boolean"
    )
      return;
    const entry = this.pending.get(value.requestId);
    // 采集子窗、子 frame 和其他窗口不能替主窗口确认导航。
    if (!entry || event.sender !== entry.sender || event.senderFrame !== entry.sender.mainFrame)
      return;
    entry.finish(value.opened);
  }

  close() {
    for (const entry of this.pending.values()) entry.finish(false);
  }
}
module.exports = { DesktopNavigation };
