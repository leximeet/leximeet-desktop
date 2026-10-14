"use strict";

const isBackgroundTest = (env = process.env) =>
  env.LEXIMEET_PROFILE === "test" && env.LEXIMEET_TEST_SILENT === "1";

/**
 * 只在后台测试进程安装保护，不改变正式应用和人工验收的原生行为。
 * 必须在框架创建首个窗口之前调用：DOM 输入仍可用，系统窗口激活被阻止。
 */
function installBackgroundTest({ app, shell, dialog, env, platform = process.platform }) {
  if (!isBackgroundTest(env)) return null;
  const violations = [];
  const blocked = {};
  let windowsCreated = 0;
  const note = (action) => {
    blocked[action] = (blocked[action] || 0) + 1;
  };
  const violation = (kind, id) => {
    if (violations.length < 100) violations.push({ kind, windowId: id });
  };
  if (platform === "darwin") app.setActivationPolicy("prohibited");
  // 无显示 Windows runner 没有可用 GPU；关掉硬件加速，但保留软件光栅，否则窗口创建会崩。
  if (platform === "win32") {
    if (typeof app.disableHardwareAcceleration === "function") app.disableHardwareAcceleration();
    app.commandLine.appendSwitch("disable-gpu");
  }
  app.commandLine.appendSwitch("mute-audio");
  if (!process.__leximeetRejectionLog) {
    process.__leximeetRejectionLog = true;
    process.on("unhandledRejection", (reason) => {
      console.error("后台测试未处理拒绝：", reason && (reason.stack || reason.message || reason));
    });
  }
  for (const method of ["show", "focus"])
    if (typeof app[method] === "function") app[method] = () => note(`app.${method}`);
  if (platform === "darwin") {
    const setPolicy = app.setActivationPolicy.bind(app);
    app.setActivationPolicy = (policy) =>
      policy === "prohibited" ? setPolicy(policy) : note("app.setActivationPolicy");
    if (app.dock?.show)
      app.dock.show = async () => {
        note("app.dock.show");
      };
  }
  app.on("browser-window-created", (_event, win) => {
    windowsCreated++;
    win.setFocusable(false);
    win.webContents.setAudioMuted(true);
    // 记录真实的意外 show/focus；禁止用事后清零掩盖启动期的违规。
    win.on("show", () => {
      violation("show", win.id);
      win.hide();
    });
    win.on("focus", () => {
      violation("focus", win.id);
      win.hide();
    });
    if (win.isVisible()) {
      violation("visible-on-create", win.id);
      win.hide();
    }
    if (win.isFocused()) violation("focused-on-create", win.id);
    for (const method of ["show", "showInactive", "focus", "restore"])
      win[method] = () => note(`window.${method}`);
    const setFocusable = win.setFocusable.bind(win);
    win.setFocusable = (value) => (value ? note("window.setFocusable") : setFocusable(false));
    const setAudioMuted = win.webContents.setAudioMuted.bind(win.webContents);
    win.webContents.setAudioMuted = (value) => {
      if (!value) note("audio.unmute");
      setAudioMuted(true);
    };
  });
  // 系统设置、Finder、原生文件框也会打断工作；误调用时明确失败，不伪造成功。
  for (const [api, methods] of [
    [shell, ["openExternal", "openPath"]],
    [
      dialog,
      [
        "showOpenDialog",
        "showOpenDialogSync",
        "showSaveDialog",
        "showSaveDialogSync",
        "showMessageBox",
        "showMessageBoxSync",
        "showErrorBox",
      ],
    ],
  ])
    for (const method of methods) {
      if (typeof api?.[method] !== "function") continue;
      api[method] = (...args) => {
        note(`host.${method}`);
        // Electron 未处理拒绝会回调 showErrorBox；再抛会二次崩溃，描述符永远写不出。
        if (method === "showErrorBox") {
          console.error(`后台测试捕获 showErrorBox：${args[0] || ""}\n${args[1] || ""}`);
          violation("showErrorBox", 0);
          return;
        }
        throw new Error(`后台自动测试禁止 ${method}；请使用独立可见验收应用检查系统交互。`);
      };
    }
  return {
    snapshot: () => ({
      active: true,
      windowsCreated,
      activationPolicy: platform === "darwin" ? "prohibited" : null,
      audioMuted: true,
      blocked: { ...blocked },
      violations: [...violations],
    }),
  };
}

module.exports = { isBackgroundTest, installBackgroundTest };
