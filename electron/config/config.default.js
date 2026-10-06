const path = require("node:path");
const { isBackgroundTest } = require("../services/background-test.cjs");

// Electron Egg 管理窗口与生命周期；关闭框架示例中无需使用的 HTTP / Socket 服务。
module.exports = () => ({
  openDevTools: false,
  singleLock: true,
  windowsOption: {
    title: "词遇 LexiMeet",
    width: 1321,
    height: 896,
    minWidth: 820,
    minHeight: 600,
    icon: path.join(__dirname, "../../resources/brand/icon.png"),
    // 自动化仍使用真实窗口和 renderer；应用保护与系统监测共同检查是否抢焦点。
    show: !isBackgroundTest(),
    focusable: !isBackgroundTest(),
    frame: true,
    backgroundColor: "#f8faf8",
    // macOS 保留真实红黄绿按钮，把网页内工具栏并入原生窗口标题区。
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 18, y: 18 } }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "bridge.js"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: !isBackgroundTest(),
    },
  },
  logger: {
    dir: process.env.LEXIMEET_LOG_DIR,
    level: "warn",
    name: "leximeet",
    appLogName: "leximeet.log",
    coreLogName: "core.log",
    errorLogName: "error.log",
  },
  remote: { enable: false },
  socketServer: { enable: false },
  httpServer: { enable: false },
  mainServer: {
    protocol: "file://",
    indexPath: "/frontend/dist/index.html",
    channelSeparator: "/",
  },
});
