"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { parseArguments, registerIsolatedHost } = require("../../scripts/lmcp/register-host.cjs");
const {
  registerNativeHost,
  unregisterNativeHost,
  assertRegistrationOwnership,
} = require("../../electron/services/lmcp/native-registration.cjs");
const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
const project = path.resolve(__dirname, "../..");

function fixture(t, marker = { profile: "test" }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-register-test-"));
  const profileRoot = path.join(root, "desktop");
  fs.mkdirSync(profileRoot, { mode: 0o700 });
  if (marker)
    fs.writeFileSync(path.join(profileRoot, "profile.json"), JSON.stringify(marker), {
      mode: 0o600,
    });
  const input = {
    profileRoot,
    browserDataDir: path.join(profileRoot, "browser-profile", "chrome"),
    extensionId: "a".repeat(32),
    electronExecutable: path.join(
      project,
      "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
    ),
    hostScript: path.join(project, "electron/native-host/main.cjs"),
  };
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, input };
}

test("隔离注册 CLI 参数全部显式指定，拒绝未知参数、重复参数和可配置 Host 名", () => {
  const args = [
    "--profile-root",
    "/isolated",
    "--browser-root",
    "/isolated/browser",
    "--extension-id",
    "a".repeat(32),
    "--electron",
    "/Electron",
    "--host-script",
    "/host.cjs",
  ];
  assert.equal(parseArguments(args).profileRoot, "/isolated");
  assert.throws(() => parseArguments(args.slice(0, -2)), /EXPLICIT_NATIVE_ARGUMENTS_REQUIRED/);
  assert.throws(
    () => parseArguments([...args, "--host-name", "old.lmcp"]),
    /INVALID_NATIVE_ARGUMENTS/,
  );
  assert.throws(
    () => parseArguments([...args, "--profile-root", "/other"]),
    /INVALID_NATIVE_ARGUMENTS/,
  );
  const help = spawnSync(
    process.execPath,
    [path.join(project, "scripts/lmcp/register-host.cjs"), "--help"],
    { encoding: "utf8" },
  );
  assert.equal(help.status, 0);
  assert.match(help.stdout, /org\.leximeet\.browser/);
  assert.equal(help.stderr, "");
});

test("隔离注册拒绝没有标记或 local 标记的 Desktop 根", (t) => {
  const absent = fixture(t, null);
  assert.throws(() => registerIsolatedHost(absent.input));
  const daily = fixture(t, { profile: "local" });
  assert.throws(() => registerIsolatedHost(daily.input), /ISOLATED_PROFILE_MARKER_REQUIRED/);
  assert.equal(fs.existsSync(path.join(daily.input.browserDataDir, "NativeMessagingHosts")), false);
});

test("隔离浏览器必须在 Desktop 隔离根内，软链接不能绕过范围", (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, "daily-chrome");
  fs.mkdirSync(outside, { mode: 0o700 });
  assert.throws(
    () => registerIsolatedHost({ ...f.input, browserDataDir: outside }),
    /ISOLATED_BROWSER_REQUIRED/,
  );
  const shortcut = path.join(f.input.profileRoot, "browser-link");
  fs.symlinkSync(outside, shortcut);
  assert.throws(
    () => registerIsolatedHost({ ...f.input, browserDataDir: path.join(shortcut, "new-profile") }),
    /ISOLATED_BROWSER_REQUIRED/,
  );
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("CLI 注册固定新 Host 并只修改本人记录，外来 manifest 保持原样", (t) => {
  const f = fixture(t);
  const result = registerIsolatedHost(f.input);
  assert.equal(result.hostName, "org.leximeet.browser");
  assert.equal(result.isolated, true);
  const ownManifest = JSON.parse(fs.readFileSync(result.manifestPath, "utf8"));
  assert.deepEqual(ownManifest.allowed_origins, [`chrome-extension://${"a".repeat(32)}/`]);
  assert(!JSON.stringify(result).includes("sessionToken"));
  registerIsolatedHost(f.input);
  unregisterNativeHost(readPrivateJson(result.recordPath));
  const foreign = '{"name":"org.leximeet.browser","path":"/someone-else"}\n';
  fs.writeFileSync(result.manifestPath, foreign, { mode: 0o600 });
  assert.throws(() => registerIsolatedHost(f.input), /NATIVE_REGISTRATION_NOT_OWNED/);
  assert.equal(fs.readFileSync(result.manifestPath, "utf8"), foreign);
});

test("多个已安装词遇来源精确登记，不能把篡改注册或通配来源当自动发现", (t) => {
  const f = fixture(t);
  const ids = ["a".repeat(32), "b".repeat(32)];
  const record = registerNativeHost({
    ...f.input,
    extensionIds: ids,
    profileName: "test",
    isolated: true,
  });
  assert.deepEqual(
    JSON.parse(fs.readFileSync(record.manifestPath)).allowed_origins,
    ids.map((id) => `chrome-extension://${id}/`),
  );
  assert.equal(assertRegistrationOwnership(record), true);
  assert.throws(
    () => registerNativeHost({ ...f.input, extensionIds: ["*"] }),
    /INVALID_NATIVE_REGISTRATION/,
  );
  const manifest = JSON.parse(fs.readFileSync(record.manifestPath));
  manifest.allowed_origins.push("chrome-extension://cccccccccccccccccccccccccccccccc/");
  fs.writeFileSync(record.manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  assert.throws(() => assertRegistrationOwnership(record), /NATIVE_REGISTRATION_CHANGED/);
});
