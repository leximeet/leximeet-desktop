"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const {
  appDataRoot,
  mcpDir,
  mcpPointerPath,
  mcpLauncherPath,
  browserUserDataDir,
  nativeMessagingHostsDir,
  xdgAutostartDir,
} = require("../../electron/services/platform/app-paths.cjs");

const HOME = path.resolve("/tmp/leximeet-home-demo");
const WIN_HOME = path.resolve("/tmp/leximeet-win-home");
const WIN_APPDATA = path.resolve("/tmp/leximeet-roaming");
const WIN_LOCAL = path.resolve("/tmp/leximeet-local");

test("资料与 MCP 指针按平台落到 appData，不把 Windows 写成 ~/.config", () => {
  assert.equal(
    appDataRoot({ homeDir: HOME, platform: "darwin" }),
    path.join(HOME, "Library", "Application Support", "LexiMeet"),
  );
  assert.equal(
    appDataRoot({ homeDir: WIN_HOME, platform: "win32", env: { APPDATA: WIN_APPDATA } }),
    path.join(WIN_APPDATA, "LexiMeet"),
  );
  assert.equal(
    appDataRoot({ homeDir: HOME, platform: "linux", env: {} }),
    path.join(HOME, ".config", "LexiMeet"),
  );
  assert.equal(
    mcpPointerPath({ homeDir: WIN_HOME, platform: "win32", env: { APPDATA: WIN_APPDATA } }),
    path.join(WIN_APPDATA, "LexiMeet", "mcp", "current.json"),
  );
  assert.equal(
    mcpLauncherPath({ homeDir: WIN_HOME, platform: "win32", env: { APPDATA: WIN_APPDATA } }),
    path.join(WIN_APPDATA, "LexiMeet", "mcp", "leximeet-mcp.exe"),
  );
  assert.equal(
    mcpLauncherPath({ homeDir: HOME, platform: "linux", env: {} }),
    path.join(HOME, ".config", "LexiMeet", "mcp", "leximeet-mcp"),
  );
  assert.equal(
    appDataRoot({ homeDir: WIN_HOME, platform: "win32" }),
    path.join(WIN_HOME, "AppData", "Roaming", "LexiMeet"),
  );
  const xdg = path.resolve("/tmp/leximeet-xdg");
  assert.equal(
    appDataRoot({
      homeDir: HOME,
      platform: "linux",
      env: { XDG_CONFIG_HOME: xdg },
    }),
    path.join(xdg, "LexiMeet"),
  );
  assert.equal(
    appDataRoot({ homeDir: HOME, platform: "linux", env: { PATH: "/no-such-bin" } }),
    path.join(HOME, ".config", "LexiMeet"),
  );
  assert.equal(path.basename(mcpDir({ homeDir: HOME, platform: "darwin" })), "mcp");
});

test("Chrome / Edge 用户资料根覆盖三端官方默认位置", () => {
  assert.equal(
    browserUserDataDir("chrome", { homeDir: HOME, platform: "darwin" }),
    path.join(HOME, "Library", "Application Support", "Google/Chrome"),
  );
  assert.equal(
    browserUserDataDir("edge", {
      homeDir: WIN_HOME,
      platform: "win32",
      env: { LOCALAPPDATA: WIN_LOCAL },
    }),
    path.join(WIN_LOCAL, "Microsoft/Edge/User Data"),
  );
  assert.equal(
    browserUserDataDir("chrome", { homeDir: HOME, platform: "linux", env: {} }),
    path.join(HOME, ".config", "google-chrome"),
  );
  assert.equal(
    nativeMessagingHostsDir("chrome", { homeDir: HOME, platform: "linux", env: {} }),
    path.join(HOME, ".config", "google-chrome", "NativeMessagingHosts"),
  );
  assert.throws(
    () => browserUserDataDir("firefox", { homeDir: HOME, platform: "darwin" }),
    /UNSUPPORTED/,
  );
  assert.equal(
    xdgAutostartDir({ homeDir: HOME, env: {} }),
    path.join(HOME, ".config", "autostart"),
  );
});

test("真实 home 未传入 env 时沿用 process.env.XDG_CONFIG_HOME", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  const xdg = path.resolve("/tmp/leximeet-real-xdg");
  process.env.XDG_CONFIG_HOME = xdg;
  try {
    assert.equal(
      browserUserDataDir("chrome", { homeDir: os.homedir(), platform: "linux" }),
      path.join(xdg, "google-chrome"),
    );
    assert.equal(xdgAutostartDir({ homeDir: os.homedir() }), path.join(xdg, "autostart"));
    assert.equal(
      appDataRoot({ homeDir: os.homedir(), platform: "linux" }),
      path.join(xdg, "LexiMeet"),
    );
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});

test("隔离 home 未传入 env 时不用本机 XDG_CONFIG_HOME", () => {
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.resolve("/tmp/leximeet-host-xdg");
  try {
    assert.equal(
      browserUserDataDir("chrome", { homeDir: HOME, platform: "linux" }),
      path.join(HOME, ".config", "google-chrome"),
    );
    assert.equal(xdgAutostartDir({ homeDir: HOME }), path.join(HOME, ".config", "autostart"));
  } finally {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
  }
});
