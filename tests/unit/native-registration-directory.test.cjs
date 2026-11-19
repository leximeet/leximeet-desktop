"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { once } = require("node:events");
const {
  registerNativeHost,
  assertRegistrationOwnership,
  unregisterNativeHost,
} = require("../../electron/services/lmcp/native-registration.cjs");
const {
  ensureRegistrationDirectory,
  readRegistrationJson,
} = require("../../electron/services/platform/registration-files.cjs");
const {
  readPrivateJson,
  writePrivateJson,
} = require("../../electron/services/platform/private-files.cjs");
const { ConnectionSettings } = require("../../electron/services/connection-settings.cjs");
const { browserUserDataDir } = require("../../electron/services/platform/app-paths.cjs");
const { LmcpGateway } = require("../../electron/services/lmcp/gateway.cjs");
const { FrameDecoder, encodeFrame } = require("../../electron/services/lmcp/framing.cjs");

// Windows 的清单位于私有目录并使用 ACL；这里验证真实 POSIX 目录权限。
function posix(name, fn) {
  return test(name, { skip: process.platform === "win32" ? "POSIX 权限专项" : false }, fn);
}

function fixture(t, mode = 0o755) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-registration-directory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const profileRoot = path.join(root, "desktop");
  const homeDir = path.join(root, "home");
  const browserDataDir = browserUserDataDir("chrome", { homeDir, platform: process.platform });
  const directory = path.join(browserDataDir, "NativeMessagingHosts");
  fs.mkdirSync(profileRoot, { mode: 0o700 });
  fs.mkdirSync(directory, { recursive: true, mode });
  fs.chmodSync(directory, mode);
  const electronExecutable = path.join(root, "fuse-fixture");
  // 登记只读取 fuse；该夹具不是可执行应用，不启动浏览器或替代真实连接验收。
  fs.writeFileSync(
    electronExecutable,
    Buffer.concat([Buffer.from("dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX"), Buffer.from([1, 1, 0x31])]),
  );
  const hostScript = path.join(root, "host.cjs");
  fs.writeFileSync(hostScript, "// 本例只验证登记，不启动宿主。\n");
  return {
    root,
    directory,
    homeDir,
    input: {
      profileRoot,
      browserDataDir,
      extensionId: "a".repeat(32),
      electronExecutable,
      hostScript,
      platform: process.platform,
      profileName: "local",
      allowDailyRegistration: true,
    },
  };
}

posix("共享0755目录可首次登记、追加来源和撤销，其他宿主及目录权限保持原样", (t) => {
  const f = fixture(t);
  const foreign = path.join(f.directory, "other.application.json");
  fs.writeFileSync(foreign, '{"name":"other.application"}\n', { mode: 0o644 });
  const before = fs.readFileSync(foreign);
  let record = registerNativeHost(f.input);
  assert.equal(assertRegistrationOwnership(record), true);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o755);
  assert.equal(fs.statSync(record.manifestPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(record.launcher).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(record.launcher)).mode & 0o777, 0o700);
  const ids = ["a".repeat(32), "b".repeat(32)];
  record = registerNativeHost({ ...f.input, extensionIds: ids });
  assert.deepEqual(
    readRegistrationJson(record.manifestPath).allowed_origins,
    ids.map((id) => `chrome-extension://${id}/`),
  );
  assert.equal(assertRegistrationOwnership(record), true);
  unregisterNativeHost(record);
  assert.equal(fs.existsSync(record.manifestPath), false);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o755);
  assert.deepEqual(fs.readFileSync(foreign), before);
});

posix("既有0700登记目录继续可用，未创建的共享目录按当前umask安全初始化", (t) => {
  const f = fixture(t, 0o700);
  const record = registerNativeHost(f.input);
  assert.equal(assertRegistrationOwnership(record), true);
  assert.equal(fs.statSync(f.directory).mode & 0o777, 0o700);
  const fresh = path.join(f.root, "new-browser", "NativeMessagingHosts");
  ensureRegistrationDirectory(fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o755 & ~process.umask());
});

posix("其他用户可写的0775和0777目录拒绝登记，不自动改权限或写入清单", (t) => {
  for (const mode of [0o775, 0o777]) {
    const f = fixture(t, mode);
    assert.throws(() => registerNativeHost(f.input), /UNSAFE_NATIVE_REGISTRATION_DIRECTORY/);
    assert.equal(fs.statSync(f.directory).mode & 0o777, mode);
    assert.deepEqual(fs.readdirSync(f.directory), []);
  }
});

posix("共享目录本身或待创建路径的祖先是软链接时拒绝，外部目录不被改写", (t) => {
  const f = fixture(t);
  const link = path.join(f.root, "browser-link");
  fs.symlinkSync(f.directory, link);
  assert.throws(() => ensureRegistrationDirectory(link), /UNSAFE_PRIVATE_PATH/);
  assert.throws(
    () => ensureRegistrationDirectory(path.join(link, "outside", "NativeMessagingHosts")),
    /UNSAFE_PRIVATE_PATH/,
  );
  assert.deepEqual(fs.readdirSync(f.directory), []);
});

posix("共享目录允许读取不等于清单可公开：0644、软链接及篡改仍拒绝", (t) => {
  const f = fixture(t);
  const record = registerNativeHost(f.input);
  fs.chmodSync(record.manifestPath, 0o644);
  assert.throws(() => readRegistrationJson(record.manifestPath), /UNSAFE_PRIVATE_PATH/);
  assert.throws(() => assertRegistrationOwnership(record), /NATIVE_REGISTRATION_CHANGED/);
  fs.chmodSync(record.manifestPath, 0o600);
  const link = path.join(f.directory, "alias.json");
  fs.symlinkSync(record.manifestPath, link);
  assert.throws(() => readRegistrationJson(link), /UNSAFE_PRIVATE_PATH/);
  fs.writeFileSync(record.manifestPath, '{"name":"tampered"}\n');
  assert.throws(() => assertRegistrationOwnership(record), /NATIVE_REGISTRATION_CHANGED/);
});

posix("缓存的自动登记在0755目录重复检查，不重建宿主；篡改后仍拒绝", async (t) => {
  const f = fixture(t);
  let registrations = 0;
  let refreshes = 0;
  let record;
  const manager = new ConnectionSettings({
    gateway: { refreshRegistrations: async () => refreshes++ },
    profile: { name: "local", root: f.input.profileRoot },
    homeDir: f.homeDir,
    platform: process.platform,
    electronExecutable: f.input.electronExecutable,
    hostScript: f.input.hostScript,
    register: (input) => {
      registrations++;
      return (record = registerNativeHost(input));
    },
  });
  await manager.registerDiscovered("chrome", [f.input.extensionId]);
  await manager.registerDiscovered("chrome", [f.input.extensionId]);
  assert.equal(registrations, 1);
  assert.equal(refreshes, 1);
  fs.writeFileSync(record.manifestPath, '{"name":"changed"}\n');
  await assert.rejects(
    () => manager.registerDiscovered("chrome", [f.input.extensionId]),
    /NATIVE_REGISTRATION_CHANGED/,
  );
});

posix("私密目录和令牌继续要求0700/0600，登记目录策略不外溢", (t) => {
  const f = fixture(t);
  const record = registerNativeHost(f.input);
  const directory = path.dirname(record.launcher);
  const token = path.join(directory, "fixture-secret.json");
  writePrivateJson(token, { fixture: true });
  fs.chmodSync(directory, 0o755);
  assert.throws(() => readPrivateJson(token), /UNSAFE_PRIVATE_PATH/);
  assert.throws(() => assertRegistrationOwnership(record), /NATIVE_REGISTRATION_CHANGED/);
});

posix("0755登记由真实Gateway加载并完成UDS认证，篡改后撤销来源和现有端口", async (t) => {
  const f = fixture(t);
  const record = registerNativeHost(f.input);
  const origin = record.origin;
  const gateway = new LmcpGateway({
    profile: { root: f.input.profileRoot, name: "test" },
    // 本例验证宿主登记与真实传输认证，不把这个 Core 边界替身算作 Java 业务验收。
    core: { request: async () => ({}) },
  });
  let socket;
  try {
    await gateway.start();
    assert.deepEqual(gateway.refreshRegistrations().registeredOrigins, [origin]);
    const descriptor = readPrivateJson(gateway.descriptorPath);
    socket = net.connect(descriptor.path || descriptor.socketPath);
    socket.on("error", () => {});
    await once(socket, "connect", { signal: AbortSignal.timeout(5000) });
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => decoder.push(chunk));
    const ready = once(decoder, "message", { signal: AbortSignal.timeout(5000) });
    socket.write(
      encodeFrame({ kind: "transport-auth", token: descriptor.token, extensionOrigin: origin }),
    );
    assert.equal((await ready)[0].kind, "transport-ready");
    const closed = once(socket, "close", { signal: AbortSignal.timeout(5000) });
    fs.writeFileSync(record.manifestPath, '{"name":"changed"}\n');
    assert.throws(() => gateway.refreshRegistrations(), /REGISTRATION_INVALID/);
    await closed;
    assert.equal(gateway.allowedOrigins.has(origin), false);
  } finally {
    socket?.destroy();
    await gateway.close();
  }
});
