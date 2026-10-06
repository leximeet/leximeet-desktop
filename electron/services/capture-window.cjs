"use strict";
const path = require("node:path");

// Main 持有两个命名窗口；采集窗只开放采集能力，不能调用整个桌面桥。
class CaptureWindows {
  constructor({
    BrowserWindow,
    sourceUrl,
    projectDir,
    silent,
    save,
    theme,
    inbox,
    retryClipboard,
  }) {
    Object.assign(this, {
      BrowserWindow,
      sourceUrl,
      projectDir,
      silent,
      save,
      theme,
      inbox,
      retryClipboard,
    });
    this.windows = new Map();
    this.initial = { mode: "capture", word: "" };
  }
  url(kind) {
    return `${this.sourceUrl}#capture-${kind}`;
  }
  owns(sender) {
    return [...this.windows.values()].some(
      (win) => !win.isDestroyed() && win.webContents === sender,
    );
  }
  trusted(event) {
    return (
      this.owns(event.sender) &&
      event.senderFrame === event.sender.mainFrame &&
      [...this.windows.keys()].some((kind) => event.senderFrame?.url === this.url(kind))
    );
  }
  async open(kind = "editor", initial = null, active = true) {
    if (initial) this.initial = initial;
    let win = this.windows.get(kind);
    if (!win || win.isDestroyed()) {
      if (initial) this.initial = initial;
      win = new this.BrowserWindow({
        title: kind === "editor" ? "遇见采集 · 词遇" : "剪贴板采集 · 词遇",
        width: 540,
        height: 620,
        minWidth: 440,
        minHeight: 480,
        show: false,
        focusable: !this.silent,
        backgroundColor: "#f7faf8",
        ...(process.platform === "darwin" ? { titleBarStyle: "hiddenInset" } : {}),
        webPreferences: {
          preload: path.join(this.projectDir, "electron/preload/capture.js"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
          backgroundThrottling: false,
        },
      });
      this.windows.set(kind, win);
      win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      win.webContents.on("will-navigate", (event, url) => {
        if (url !== this.url(kind)) event.preventDefault();
      });
      win.webContents.on("will-attach-webview", (event) => event.preventDefault());
      win.on("close", (event) => {
        // 用户收起编辑器仍保留草稿；关闭提醒明确视为本批不采集。
        event.preventDefault();
        if (kind === "inbox") this.inbox.cancel();
        win.hide();
      });
      await win.loadURL(this.url(kind));
    }
    win.webContents.send("leximeet:capture-state");
    if (!this.silent) {
      if (active) {
        win.show();
        win.focus();
      } else win.showInactive();
    }
    if (kind === "inbox" && this.inboxReady) this.inbox.ready();
    return { opened: true };
  }
  publish() {
    for (const [kind, win] of this.windows) {
      if (!win.isDestroyed()) {
        win.webContents.send("leximeet:capture-state");
        if (kind === "inbox" && !this.inbox.items.size) win.hide();
      }
    }
  }
  async action(payload, sender) {
    if (
      !payload ||
      Object.keys(payload).some(
        (key) =>
          ![
            "action",
            "mode",
            "word",
            "context",
            "sourceTitle",
            "sourceUrl",
            "id",
            "collect",
          ].includes(key),
      )
    )
      throw new Error("采集参数无效");
    const popup = this.owns(sender);
    switch (payload.action) {
      case "retryClipboard": {
        if (popup || Object.keys(payload).length !== 1) throw new Error("请在主窗口重试剪贴板采集");
        if (!this.retryClipboard) throw new Error("剪贴板重试暂不可用");
        const result = await this.retryClipboard();
        this.inbox.retryFailedNotifications();
        // 这次点击是用户明确操作；系统仍不能送达时才显示原待处理项，不自动弹窗。
        if (
          this.inbox.snapshot().deliveryRetryRequired ||
          (this.inbox.mode === "popup" && this.inbox.items.size)
        )
          await this.open("inbox");
        return result;
      }
      case "open":
        if (popup) throw new Error("采集窗不能创建其他窗口");
        if (
          payload.word !== undefined &&
          (typeof payload.word !== "string" || payload.word.length > 120)
        )
          throw new Error("采集单词无效");
        if (!["capture", "collect"].includes(payload.mode || "capture"))
          throw new Error("采集方式无效");
        return this.open("editor", {
          mode: payload.mode || "capture",
          word: payload.word || "",
        });
      case "state":
        if (!popup) throw new Error("请在采集窗口读取状态");
        return {
          ...this.initial,
          kind: [...this.windows].find(([, win]) => win.webContents === sender)?.[0],
          theme: await this.theme(),
          ...this.inbox.snapshot(),
        };
      case "ready":
        if (this.windows.get("inbox")?.webContents !== sender) throw new Error("无效的提醒窗口");
        this.inboxReady = true;
        this.inbox.ready();
        return { ready: true };
      case "save": {
        if (this.windows.get("editor")?.webContents !== sender) throw new Error("请在采集窗口保存");
        const { action, mode = "capture", ...data } = payload;
        if (!["capture", "collect"].includes(mode)) throw new Error("采集方式无效");
        const result = await this.save({ ...data, action: mode });
        this.initial = { mode, word: "" };
        return {
          saved: true,
          captureStatus: result?.captureResult?.captureStatus || "created",
        };
      }
      case "decision":
        if (
          this.windows.get("inbox")?.webContents !== sender ||
          typeof payload.collect !== "boolean"
        )
          throw new Error("采集决定无效");
        return {
          decided: await this.inbox.decide(payload.id, payload.collect),
        };
      case "close": {
        if (!popup) throw new Error("无效的采集窗口");
        [...this.windows.values()].find((win) => win.webContents === sender).close();
        return { closed: true };
      }
      default:
        throw new Error("采集动作无效");
    }
  }
  close() {
    for (const win of this.windows.values()) if (!win.isDestroyed()) win.destroy();
    this.windows.clear();
  }
}
module.exports = { CaptureWindows };
