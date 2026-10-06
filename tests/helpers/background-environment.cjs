"use strict";

// trace 中只能继承工具运行必需的环境，不把操作者的云端凭证带入报告。
const INHERITED = [
  "PATH",
  "JAVA_HOME",
  "LEXIMEET_JAVA",
  "LANG",
  "LC_ALL",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "APPDATA",
  "LOCALAPPDATA",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XAUTHORITY",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
];
const RESERVED = new Set([
  "LEXIMEET_PROFILE",
  "LEXIMEET_DATA_DIR",
  "LEXIMEET_TEST_SILENT",
  "LEXIMEET_SEED_DEMO",
  "LEXIMEET_TEST_BROWSER",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
]);

// 用例可配置业务数据，不能通过 extraEnv 关闭静默或切换到正式资料。
function backgroundEnvironment({
  profileDir,
  seed,
  browserSandbox,
  extraEnv = {},
  inherited = process.env,
}) {
  for (const key of Object.keys(extraEnv))
    if (RESERVED.has(key)) throw new Error(`后台测试不能覆盖隔离环境 ${key}`);
  return {
    ...Object.fromEntries(
      INHERITED.filter((key) => inherited[key] !== undefined).map((key) => [key, inherited[key]]),
    ),
    ...extraEnv,
    LEXIMEET_PROFILE: "test",
    LEXIMEET_DATA_DIR: profileDir,
    LEXIMEET_SEED_DEMO: seed ? "1" : "0",
    LEXIMEET_TEST_SILENT: "1",
    LEXIMEET_TEST_BROWSER: browserSandbox ? "1" : "0",
  };
}

// 自动门禁不启动 Playwright Inspector / UI 或可见浏览器。
function assertBackgroundRunner(argv = process.argv, env = process.env) {
  if (
    argv.some((arg) => /^(--headed|--debug|--ui(?:-host|-port)?)(?:=|$)/.test(arg)) ||
    (env.PWDEBUG && env.PWDEBUG !== "0")
  )
    throw new Error(
      "后台自动测试不允许 --headed / --debug / --ui / PWDEBUG；可见验收请运行 npm run accept:desktop。",
    );
}

module.exports = { backgroundEnvironment, assertBackgroundRunner };
