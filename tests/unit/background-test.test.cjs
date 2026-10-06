"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  installBackgroundTest,
  isBackgroundTest,
} = require("../../electron/services/background-test.cjs");
const {
  backgroundEnvironment,
  assertBackgroundRunner,
} = require("../helpers/background-environment.cjs");
const { playReminderAudio } = require("../../electron/services/reminder-audio.cjs");

function nativeFixture(
  env = { LEXIMEET_PROFILE: "test", LEXIMEET_TEST_SILENT: "1" },
  platform = "darwin",
) {
  const calls = [];
  const app = Object.assign(new EventEmitter(), {
    setActivationPolicy: (value) => calls.push(["policy", value]),
    commandLine: { appendSwitch: (value) => calls.push(["switch", value]) },
    focus: () => calls.push(["app.focus"]),
    show: () => calls.push(["app.show"]),
    dock: { show: async () => calls.push(["dock.show"]) },
  });
  const shell = {
    openExternal: async () => calls.push(["external"]),
    openPath: async () => calls.push(["path"]),
  };
  const dialog = { showOpenDialog: async () => calls.push(["dialog"]) };
  const guard = installBackgroundTest({ app, shell, dialog, env, platform });
  function window(id, visible = false) {
    const win = Object.assign(new EventEmitter(), {
      id,
      focusable: true,
      visible,
      focused: false,
      setFocusable(value) {
        this.focusable = value;
      },
      isVisible() {
        return this.visible;
      },
      isFocused() {
        return this.focused;
      },
      hide() {
        this.visible = false;
      },
      show() {
        calls.push(["show", id]);
      },
      showInactive() {
        calls.push(["inactive", id]);
      },
      focus() {
        calls.push(["focus", id]);
      },
      restore() {
        calls.push(["restore", id]);
      },
      webContents: {
        muted: false,
        setAudioMuted(value) {
          this.muted = value;
        },
      },
    });
    app.emit("browser-window-created", {}, win);
    return win;
  }
  return { app, shell, dialog, guard, calls, window };
}

test("只有明确的 test + silent 才安装后台保护，人工验收不会被隐藏", () => {
  for (const env of [
    {},
    { LEXIMEET_PROFILE: "demo", LEXIMEET_TEST_SILENT: "1" },
    { LEXIMEET_PROFILE: "test" },
    { LEXIMEET_PROFILE: "test", LEXIMEET_TEST_SILENT: "0" },
  ])
    assert.equal(isBackgroundTest(env), false);
  assert.equal(isBackgroundTest({ LEXIMEET_PROFILE: "test", LEXIMEET_TEST_SILENT: "1" }), true);
});
test("正式应用保留窗口显示和原生操作，没有测试策略副作用", async () => {
  const f = nativeFixture({ LEXIMEET_PROFILE: "local" });
  assert.equal(f.guard, null);
  f.window(1).show();
  await f.shell.openExternal();
  assert.deepEqual(f.calls, [["show", 1], ["external"]]);
});
test("首个窗口创建时就禁止聚焦并静音，之后所有采集窗口也受保护", () => {
  const f = nativeFixture();
  for (let id = 1; id <= 3; id++) {
    const win = f.window(id);
    assert.equal(win.focusable, false);
    assert.equal(win.webContents.muted, true);
  }
  assert.equal(f.guard.snapshot().windowsCreated, 3);
  assert.deepEqual(f.calls, [
    ["policy", "prohibited"],
    ["switch", "mute-audio"],
  ]);
});
test("激活和取消静音的请求被当场阻止，不会调用真实原生方法", async () => {
  const f = nativeFixture(),
    win = f.window(1);
  for (const method of ["show", "showInactive", "focus", "restore"]) win[method]();
  win.setFocusable(true);
  win.webContents.setAudioMuted(false);
  f.app.show();
  f.app.focus();
  await f.app.dock.show();
  f.app.setActivationPolicy("regular");
  assert.equal(win.focusable, false);
  assert.equal(win.webContents.muted, true);
  assert.deepEqual(f.calls, [
    ["policy", "prohibited"],
    ["switch", "mute-audio"],
  ]);
  assert.equal(f.guard.snapshot().blocked["app.setActivationPolicy"], 1);
  assert.deepEqual(f.guard.snapshot().violations, []);
});
test("意外原生 show/focus 从创建期累计，收起后也不会被清零", () => {
  const f = nativeFixture(),
    win = f.window(1, true);
  assert.equal(win.visible, false);
  win.emit("focus");
  win.emit("show");
  assert.deepEqual(
    f.guard.snapshot().violations.map((v) => v.kind),
    ["visible-on-create", "focus", "show"],
  );
  assert.equal(f.guard.snapshot().violations.length, 3);
});
test("Finder、系统设置和文件选择框误调用明确报错，没有伪造成功", () => {
  const f = nativeFixture();
  for (const run of [
    () => f.shell.openExternal(),
    () => f.shell.openPath(),
    () => f.dialog.showOpenDialog(),
  ])
    assert.throws(run, /后台自动测试禁止/);
  assert.equal(f.calls.length, 2);
});
test("非 macOS 保留窗口保护和静音，不调用 macOS 激活策略", () => {
  const f = nativeFixture(undefined, "linux");
  assert.equal(f.window(1).focusable, false);
  assert.deepEqual(f.calls, [["switch", "mute-audio"]]);
  assert.equal(f.guard.snapshot().activationPolicy, null);
});
test("测试环境隔离优先且 trace 不继承宿主凭证或 Node 注入", () => {
  const env = backgroundEnvironment({
    profileDir: "/owned/profile",
    seed: true,
    inherited: {
      PATH: "/tools",
      AWS_SECRET_ACCESS_KEY: "private",
      ELECTRON_RUN_AS_NODE: "1",
      NODE_OPTIONS: "unsafe",
    },
    extraEnv: { LEXIMEET_TEST_CLIPBOARD_TEXT: "apple" },
  });
  assert.equal(env.LEXIMEET_TEST_SILENT, "1");
  assert.equal(env.LEXIMEET_DATA_DIR, "/owned/profile");
  assert.equal(env.LEXIMEET_SEED_DEMO, "1");
  assert.equal(env.LEXIMEET_TEST_CLIPBOARD_TEXT, "apple");
  for (const key of ["AWS_SECRET_ACCESS_KEY", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"])
    assert.equal(env[key], undefined);
});
test("用例不能通过 extraEnv 切换到正式库、关闭静默或注入启动代码", () => {
  for (const key of [
    "LEXIMEET_PROFILE",
    "LEXIMEET_DATA_DIR",
    "LEXIMEET_TEST_SILENT",
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
  ])
    assert.throws(
      () =>
        backgroundEnvironment({
          profileDir: "/owned",
          extraEnv: { [key]: "override" },
        }),
      /不能覆盖隔离环境/,
    );
});
test("后台 runner 拒绝可见浏览器、Inspector 和交互 UI，正常命令不受影响", () => {
  assert.doesNotThrow(() =>
    assertBackgroundRunner(["test", "--grep", "practice"], { PWDEBUG: "0" }),
  );
  for (const flag of [
    "--headed",
    "--headed=true",
    "--debug",
    "--ui",
    "--ui-port=8000",
    "--ui-host",
    "PWDEBUG",
  ])
    assert.throws(
      () =>
        assertBackgroundRunner(["test", flag], {
          PWDEBUG: flag === "PWDEBUG" ? "1" : "0",
        }),
      /后台自动测试不允许/,
    );
});
test("后台通知发音仍获取音频，但不会把音频交给系统播放器", async () => {
  const words = [];
  await playReminderAudio(
    {
      speak: async ({ word }) => {
        words.push(word);
        return {};
      },
    },
    "apple",
    { silent: true },
  );
  // 没有 data 的响应若进入文件/播放器分支会失败，成功证明没有触发原生输出。
  assert.deepEqual(words, ["apple"]);
});
test("静音不掩盖音频提供者的失败", async () => {
  await assert.rejects(
    playReminderAudio(
      {
        speak: async () => {
          throw new Error("提供者失败");
        },
      },
      "apple",
      { silent: true },
    ),
    /提供者失败/,
  );
});
