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
  app.commandLine.appendSwitch("mute-audio");
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
      api[method] = () => {
        note(`host.${method}`);
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
