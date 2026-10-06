"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { LmcpGateway } = require("../../electron/services/lmcp/gateway.cjs");
const {
  registerNativeHost,
  unregisterNativeHost,
} = require("../../electron/services/lmcp/native-registration.cjs");
const {
  FrameDecoder,
  encodeFrame,
  MAX_FRAME_BYTES,
} = require("../../electron/services/lmcp/framing.cjs");
const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
const { buildNativeHost } = require("../../scripts/lmcp/build-host.cjs");
const { startFocusMonitor } = require("../helpers/macos-focus-monitor.cjs");

const project = path.resolve(__dirname, "../..");
const electron = path.join(
  project,
  "node_modules/electron/dist/Electron.app/Contents/MacOS/Electron",
);
const script = path.join(project, "electron/native-host/main.cjs");
const origin = `chrome-extension://${"a".repeat(32)}/`;
const otherOrigin = `chrome-extension://${"b".repeat(32)}/`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 模拟 Core 的权限与回执，真实验证独立 Host/stdio/UDS；不冒充应用业务验收。
class CoreDouble {
  constructor() {
    this.workspaceId = randomUUID();
    this.generation = randomUUID();
    this.desktopInstanceId = randomUUID();
    this.calls = [];
    this.closeCalls = [];
    this.ledger = new Map();
    this.connected = new Map();
    this.pairings = new Map();
  }
  async request(endpoint, method, input) {
    if (endpoint === "/api/lmcp/manage") {
      this.closeCalls.push(input);
      return {
        desktopInstanceId: this.desktopInstanceId,
        workspaceId: this.workspaceId,
        generation: this.generation,
        clients: [],
      };
    }
    assert.equal(endpoint, "/api/lmcp/rpc");
    assert.equal(method, "POST");
    assert.match(input.extensionOrigin, /^chrome-extension:\/\/[a-p]{32}\/$/);
    assert.equal(input.connectionId, input.envelope.connectionId);
    this.calls.push(input);
    const envelope = input.envelope;
    let result = {};
    if (envelope.method === "hello")
      result = { apiVersion: "1.0.0", connectionId: input.connectionId };
    if (envelope.method === "pair") {
      this.connected.set(input.connectionId, envelope.params.clientInstanceId);
      if (!this.pairings.has(envelope.params.clientInstanceId))
        this.pairings.set(envelope.params.clientInstanceId, randomUUID());
      result = {
        authorization: {
          sessionId: randomUUID(),
          sessionToken: "s".repeat(64),
          workspaceId: this.workspaceId,
          generation: this.generation,
          authorizationEpoch: "1",
        },
      };
    }
    if (envelope.method === "registerHost")
      result = {
        extensionId: "browser/1",
        grantId: randomUUID(),
        grantToken: "g".repeat(64),
        expiresAt: new Date(Date.now() + 600000).toISOString(),
        capabilities: envelope.params.capabilities,
        owner: {
          pairingId: this.pairings.get(this.connected.get(input.connectionId)),
          desktopInstanceId: this.desktopInstanceId,
          clientInstanceId: this.connected.get(input.connectionId),
          workspaceId: this.workspaceId,
          generation: this.generation,
          authorizationEpoch: "1",
        },
      };
    if (envelope.method === "recordEncounter") {
      if (!this.ledger.has(envelope.params.mutationId))
        this.ledger.set(envelope.params.mutationId, { word: envelope.params.headword, times: 1 });
      result = this.ledger.get(envelope.params.mutationId);
      if (envelope.params.delayMs) await delay(envelope.params.delayMs);
    }
    if (envelope.method === "getOperation") result = this.ledger.get(envelope.params.mutationId);
    if (envelope.method === "getPublicEntry") result = { large: "x".repeat(MAX_FRAME_BYTES) };
    return {
      apiVersion: "1.0.0",
      requestId: envelope.requestId,
      connectionId: envelope.connectionId,
      method: envelope.method,
      ok: true,
      result,
    };
  }
}

async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-native-test-"));
  const profile = { name: "test", root: path.join(root, "desktop") };
  fs.mkdirSync(profile.root, { mode: 0o700 });
  const { externalBundle = false, ...gatewayOptions } = options;
  const core = new CoreDouble();
  const gateway = new LmcpGateway({
    core,
    profile,
    allowedOrigins: [origin, otherOrigin],
    ...gatewayOptions,
  });
  let registration;
  let focus;
  const children = [];
  t.after(async () => {
    try {
      await Promise.all(children.map(stopChild));
      await gateway.close();
      assert.equal(fs.existsSync(gateway.socketPath), false, "只回收本次UDS");
      assert.equal(
        fs.existsSync(gateway.socketDirectory),
        false,
        "回收本次隔离资料根的空Socket目录",
      );
      if (registration && fs.existsSync(registration.recordPath))
        unregisterNativeHost(registration);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (focus) {
        const report = await focus.stop();
        t.diagnostic(`LMCP_NATIVE_FOCUS ${JSON.stringify(report)}`);
        assert.equal(report.complete, true, report.error || "焦点监测必须覆盖启动前至退出后");
        assert.deepEqual(report.violations, [], "Native Host 和监测进程不能成为前台应用");
      }
    }
  });
  focus = await startFocusMonitor({ root: project });
  await gateway.start();
  const hostScript = externalBundle
    ? buildNativeHost({
        projectDir: project,
        outputDir: path.join(root, "packaged-resources", "native-host"),
      }).hostScript
    : script;
  registration = registerNativeHost({
    extensionId: "a".repeat(32),
    browserDataDir: path.join(root, "browser"),
    profileRoot: profile.root,
    electronExecutable: electron,
    hostScript,
    profileName: "test",
    isolated: true,
    hostName: "org.leximeet.browser.test",
  });
  function browser(caller = origin) {
    // PATH 没有 Node；NODE_OPTIONS 注入会被安装器生成的 launcher 清除。
    const child = spawn(registration.launcher, [caller], {
      env: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "--require=/not-present", ELECTRON_NO_ASAR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    focus.track(child.pid);
    children.push(child);
    const decoder = new FrameDecoder();
    const inbox = [];
    const waits = [];
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    const adapter = {
      child,
      inbox,
      get stderr() {
        return stderr;
      },
      connectionId: randomUUID(),
      send(value) {
        child.stdin.write(encodeFrame(value));
      },
      next(predicate = () => true, timeout = 15000) {
        const at = inbox.findIndex(predicate);
        if (at >= 0) return Promise.resolve(inbox.splice(at, 1)[0]);
        return new Promise((resolve, reject) => {
          const wait = { predicate, resolve, reject };
          wait.timer = setTimeout(() => {
            const i = waits.indexOf(wait);
            if (i >= 0) waits.splice(i, 1);
            reject(new Error(`消息等待超时(${this.lastMethod || "host-request"})，诊断:${stderr}`));
          }, timeout);
          waits.push(wait);
        });
      },
      async call(method, params = {}, authorization) {
        this.lastMethod = method;
        const requestId = randomUUID();
        const envelope = {
          apiMajor: 1,
          connectionId: this.connectionId,
          requestId,
          method,
          params,
        };
        if (authorization) envelope.authorization = authorization;
        this.send(envelope);
        return this.next((message) => message.requestId === requestId);
      },
      async connected(clientInstanceId = randomUUID()) {
        assert.equal((await this.call("hello", { connectionId: this.connectionId })).ok, true);
        this.clientInstanceId = clientInstanceId;
        const pair = await this.call("pair", {
          clientInstanceId: this.clientInstanceId,
          invitationId: randomUUID(),
          invitationToken: "t".repeat(43),
        });
        this.authorization = pair.result.authorization;
        const registered = await this.call(
          "registerHost",
          {
            extensionId: "browser/1",
            capabilities: ["browser.context/1", "browser.open-source/1"],
          },
          this.authorization,
        );
        this.grant = registered.result;
        return this;
      },
    };
    decoder.on("message", (message) => {
      const at = waits.findIndex((wait) => wait.predicate(message));
      if (at < 0) inbox.push(message);
      else {
        const [wait] = waits.splice(at, 1);
        clearTimeout(wait.timer);
        wait.resolve(message);
      }
    });
    decoder.on("error", (error) => {
      for (const wait of waits.splice(0)) {
        clearTimeout(wait.timer);
        wait.reject(error);
      }
    });
    child.stdout.on("data", (data) => decoder.push(data));
    child.once("exit", () => {
      for (const wait of waits.splice(0)) {
        clearTimeout(wait.timer);
        wait.reject(new Error(`Host退出:${stderr}`));
      }
    });
    return adapter;
  }
  return { root, core, gateway, registration, browser };
}

// 测试即使遇到退出回归，也只清理自己启动的子进程并在有限时间内返回。
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  let timer;
  await Promise.race([
    closed,
    new Promise((resolve) => {
      timer = setTimeout(resolve, 1500);
    }),
  ]);
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([
      closed,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Native 测试子进程清理超时")), 1500),
      ),
    ]);
  }
}

function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Host 没有按时退出")), 5000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

test("随包 Electron Native Host 在没有系统 Node 的独立进程双向传输", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const invocationId = randomUUID();
  const pending = f.gateway.invokeBrowser(
    browser.connectionId,
    "browser.getContext",
    {},
    { invocationId },
  );
  const request = await browser.next((message) => message.kind === "host-request");
  assert.equal(request.invocationId, invocationId);
  assert.equal(request.grantId, browser.grant.grantId);
  browser.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: browser.connectionId,
    requestId: request.requestId,
    invocationId,
    method: request.method,
    ok: true,
    result: { page: null },
  });
  assert.deepEqual((await pending).result, { page: null });
  assert.equal(browser.stderr, "");
  assert.equal(f.gateway.status().connections.length, 1);
  assert.equal(fs.statSync(f.gateway.descriptorPath).mode & 0o777, 0o600);
  const descriptor = readPrivateJson(f.gateway.descriptorPath);
  assert.equal(fs.statSync(descriptor.socketPath).mode & 0o777, 0o600);
  assert(!JSON.stringify(f.gateway.status()).includes(descriptor.token));
});

test("外置 Host 发布物料可独立运行，不读取 app.asar 或系统 Node", async (t) => {
  const f = await fixture(t, { externalBundle: true });
  const browser = await f.browser().connected();
  assert.equal((await browser.call("getWorkspace", {}, browser.authorization)).ok, true);
  const bundleRoot = path.join(f.root, "packaged-resources", "native-host");
  const bundle = JSON.parse(fs.readFileSync(path.join(bundleRoot, "bundle.json")));
  assert.equal(bundle.files.length, 3);
  assert.equal(bundle.runtime, "electron-run-as-node");
  assert.equal(browser.stderr, "");
});

test("Desktop启动后外部登记自动刷新来源，篡改清单立即撤来源并关闭旧Port", async (t) => {
  const f = await fixture(t, { allowedOrigins: [], registrationPollMs: 100 });
  const instanceId = readPrivateJson(f.gateway.descriptorPath).instanceId;
  const deadline = Date.now() + 5000;
  while (
    !readPrivateJson(f.gateway.descriptorPath).allowedOrigins.includes(origin) &&
    Date.now() < deadline
  )
    await delay(20);
  assert.deepEqual(f.gateway.refreshRegistrations().registeredOrigins, [origin]);
  assert.equal(
    readPrivateJson(f.gateway.descriptorPath).instanceId,
    instanceId,
    "刷新登记无需重启Desktop或换私有token",
  );
  const browser = await f.browser().connected();
  fs.appendFileSync(f.registration.manifestPath, " ");
  assert.throws(() => f.gateway.refreshRegistrations(), { code: "REGISTRATION_INVALID" });
  assert.deepEqual(readPrivateJson(f.gateway.descriptorPath).allowedOrigins, []);
  assert.equal(await exited(browser.child), 0);
  // 恢复本例修改的字节，确保自身注册仍可按原 hash 安全撤销。
  const manifest = fs.readFileSync(f.registration.manifestPath);
  fs.writeFileSync(f.registration.manifestPath, manifest.subarray(0, manifest.length - 1));
  assert.deepEqual(f.gateway.refreshRegistrations().registeredOrigins, [origin]);
  assert.equal(f.gateway.status().lastError, null, "合法登记恢复后不保留已经解决的注册错误");
});

test("Core运行代次改变即清缓存grant，旧反向ACK不能重新赋权", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  f.core.generation = randomUUID();
  await assert.rejects(
    () => f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
    { code: "HOST_UNAVAILABLE" },
  );
  assert.deepEqual(f.gateway.status().connections[0].hostCapabilities, []);
  browser.authorization.generation = f.core.generation;
  assert.equal(
    (
      await browser.call(
        "registerHost",
        { extensionId: "browser/1", capabilities: ["browser.context/1"] },
        browser.authorization,
      )
    ).ok,
    true,
  );
  const failed = assert.rejects(
    f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
    { code: "STALE_GRANT" },
  );
  const query = await browser.next((message) => message.kind === "host-request");
  f.core.generation = randomUUID();
  browser.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: browser.connectionId,
    requestId: query.requestId,
    invocationId: query.invocationId,
    method: query.method,
    ok: true,
    result: { page: null },
  });
  await failed;
});

test("更换grant已提交却丢ACK时先停旧能力，超时后不自动恢复或重做", async (t) => {
  const f = await fixture(t, { forwardTimeoutMs: 30 });
  const browser = await f.browser().connected();
  const original = f.core.request.bind(f.core);
  f.core.request = async (endpoint, method, input) => {
    const result = await original(endpoint, method, input);
    if (input?.envelope?.method === "registerHost") await delay(80);
    return result;
  };
  const result = await browser.call(
    "registerHost",
    { extensionId: "browser/1", capabilities: ["browser.context/1"] },
    browser.authorization,
  );
  assert.equal(result.error.code, "DEADLINE_EXCEEDED");
  await assert.rejects(
    () => f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
    { code: "HOST_UNAVAILABLE" },
  );
  await delay(90);
  assert.deepEqual(f.gateway.status().connections[0].hostCapabilities, []);
  assert.equal(f.core.calls.filter((item) => item.envelope.method === "registerHost").length, 2);
});

test("Core撤权或工作区改变后立即清除反向grant，不再调用浏览器能力", async (t) => {
  const f = await fixture(t);
  const original = f.core.request.bind(f.core);
  let code = "AUTHORIZATION_REVOKED";
  f.core.request = async (endpoint, method, input) => {
    if (input?.envelope?.method !== "getWord") return original(endpoint, method, input);
    const envelope = input.envelope;
    return {
      apiVersion: "1.0.0",
      requestId: envelope.requestId,
      connectionId: envelope.connectionId,
      method: envelope.method,
      ok: false,
      error: { code, message: "授权已失效", retryable: false },
    };
  };
  for (code of [
    "PAIRING_REVOKED",
    "FORBIDDEN",
    "AUTHORIZATION_REVOKED",
    "WORKSPACE_MISMATCH",
    "GENERATION_MISMATCH",
  ]) {
    const browser = await f.browser().connected();
    assert.equal((await browser.call("getWord", {}, browser.authorization)).error.code, code);
    await assert.rejects(
      () => f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
      { code: "HOST_UNAVAILABLE" },
    );
    assert.deepEqual(
      f.gateway.status().connections.find((item) => item.connectionId === browser.connectionId)
        .hostCapabilities,
      [],
    );
  }
});

test("同一pairing的新Port登记grant后旧Port能力立即失效", async (t) => {
  const f = await fixture(t);
  const clientInstanceId = randomUUID();
  const old = await f.browser().connected(clientInstanceId);
  const current = await f.browser().connected(clientInstanceId);
  assert.equal(old.grant.owner.pairingId, current.grant.owner.pairingId);
  await assert.rejects(() => f.gateway.invokeBrowser(old.connectionId, "browser.getContext", {}), {
    code: "HOST_UNAVAILABLE",
  });
  const pending = f.gateway.invokeBrowser(current.connectionId, "browser.getContext", {});
  const request = await current.next((message) => message.kind === "host-request");
  current.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: current.connectionId,
    requestId: request.requestId,
    invocationId: request.invocationId,
    method: request.method,
    ok: true,
    result: { page: null },
  });
  assert.equal((await pending).ok, true);
  assert.deepEqual(
    f.gateway.status().connections.find((item) => item.connectionId === old.connectionId)
      .hostCapabilities,
    [],
  );
});

test("权限收窄后只恢复终态摘要，getOperation不能返回越权的完整内容", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const sourceGrantId = browser.grant.grantId;
  const invocationId = randomUUID();
  const lost = f.gateway.invokeBrowser(
    browser.connectionId,
    "browser.openSource",
    { url: "https://example.org/private-source" },
    { invocationId, timeoutMs: 20 },
  );
  await browser.next((message) => message.kind === "host-request");
  await assert.rejects(lost, { code: "DEADLINE_EXCEEDED" });
  const registered = await browser.call(
    "registerHost",
    { extensionId: "browser/1", capabilities: ["browser.context/1"] },
    browser.authorization,
  );
  assert.equal(registered.ok, true);
  const recover = async (result) => {
    const pending = f.gateway.recoverBrowserOperation(browser.connectionId, {
      sourceGrantId,
      invocationId,
    });
    const query = await browser.next((message) => message.kind === "host-request");
    browser.send({
      apiMajor: 1,
      kind: "host-response",
      connectionId: browser.connectionId,
      requestId: query.requestId,
      invocationId: query.invocationId,
      method: query.method,
      ok: true,
      result: { sourceGrantId, invocationId, ...result },
    });
    return pending;
  };
  const response = await recover({
    status: "applied",
    resultDigest: "b".repeat(64),
    contentStatus: "not-authorized",
    receipt: null,
  });
  assert.equal(response.result.contentStatus, "not-authorized");
  const original = f.gateway
    .status()
    .browserOperations.find((item) => item.invocationId === invocationId);
  assert.equal(original.status, "applied");
  assert.equal(original.resultDigest, "b".repeat(64));
  assert(!JSON.stringify(original).includes("private-source"));
  await assert.rejects(
    () =>
      recover({
        status: "applied",
        resultDigest: "b".repeat(64),
        contentStatus: "available",
        receipt: {
          method: "browser.openSource",
          ok: true,
          result: { status: "opened", actionId: null },
        },
      }),
    { code: "HOST_UNAVAILABLE" },
  );
});

test("真实 argv 来源不在 allowlist 即退出，消息自报来源不能获权", async (t) => {
  const f = await fixture(t);
  const invalid = f.browser(`chrome-extension://${"c".repeat(32)}/`);
  assert.equal(await exited(invalid.child), 1);
  assert.match(invalid.stderr, /SOURCE_REJECTED/);
  assert.equal(f.core.calls.length, 0);
  const browser = f.browser();
  const forged = {
    apiMajor: 1,
    connectionId: browser.connectionId,
    requestId: randomUUID(),
    method: "hello",
    params: {},
    extensionOrigin: otherOrigin,
  };
  browser.send(forged);
  await exited(browser.child);
  assert.equal(f.core.calls.length, 0);
});

test("大帧头和重复授权键立即断开，不传给 Core", async (t) => {
  const f = await fixture(t);
  const big = f.browser();
  const header = Buffer.alloc(4);
  header.writeUInt32LE(MAX_FRAME_BYTES + 1);
  big.child.stdin.write(header);
  assert.equal(await exited(big.child), 1);
  assert.equal(f.core.calls.length, 0);
  const duplicate = f.browser();
  const bytes = Buffer.from('{"method":"hello","method":"pair"}');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(bytes.length);
  duplicate.child.stdin.write(Buffer.concat([head, bytes]));
  assert.equal(await exited(duplicate.child), 1);
  assert.equal(f.core.calls.length, 0);
});

test("多个 Browser profile 反向请求精确路由，不广播或串实例", async (t) => {
  const f = await fixture(t);
  const a = await f.browser(origin).connected();
  const b = await f.browser(otherOrigin).connected();
  const pending = f.gateway.invokeBrowser(b.connectionId, "browser.openSource", {
    url: "https://example.org/reading",
  });
  const request = await b.next((message) => message.kind === "host-request");
  await delay(25);
  assert.equal(a.inbox.filter((message) => message.kind === "host-request").length, 0);
  b.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: b.connectionId,
    requestId: request.requestId,
    invocationId: request.invocationId,
    method: request.method,
    ok: true,
    result: { status: "opened", actionId: null },
  });
  assert.equal((await pending).result.status, "opened");
  assert.equal(f.gateway.status().connections.length, 2);
  await assert.rejects(
    f.gateway.invokeBrowser(a.connectionId, "browser.openSource", { url: "file:///etc/passwd" }),
    { code: "INVALID_ARGUMENT" },
  );
});

test("已提交后丢 ACK 保留原 mutationId，可查回执且不重复写入", async (t) => {
  const committed = [];
  const f = await fixture(t, {
    forwardTimeoutMs: 20,
    onCaptureCommitted: (value) => committed.push(value),
  });
  const browser = await f.browser().connected();
  const mutationId = randomUUID();
  const result = await browser.call(
    "recordEncounter",
    { mutationId, headword: "resilient", delayMs: 75 },
    browser.authorization,
  );
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "DEADLINE_EXCEEDED");
  const receipt = await browser.call("getOperation", { mutationId }, browser.authorization);
  assert.equal(receipt.result.word, "resilient");
  assert.equal(committed.length, 0, "超时本身不能冒充已确认的采集通知");
  await delay(80);
  await browser.call(
    "recordEncounter",
    { mutationId, headword: "resilient" },
    browser.authorization,
  );
  assert.equal(
    committed.length,
    2,
    "真实任务完成即消费回执，丢 ACK 也不遗漏；通知服务独立按事件去重",
  );
  assert.equal(f.core.ledger.size, 1);
  assert.equal(f.core.ledger.get(mutationId).times, 1);
});

test("反向丢 ACK 结果未知，带原 invocation/grant 查回执，不自动再执行", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const invocationId = randomUUID();
  const failure = assert.rejects(
    f.gateway.invokeBrowser(
      browser.connectionId,
      "browser.openSource",
      { url: "https://example.org" },
      { invocationId, timeoutMs: 25 },
    ),
    (error) => {
      assert.equal(error.code, "DEADLINE_EXCEEDED");
      assert.equal(error.invocationId, invocationId);
      assert.equal(error.sourceGrantId, browser.grant.grantId);
      assert.equal(error.resultUnknown, true);
      return true;
    },
  );
  const original = await browser.next((message) => message.kind === "host-request");
  await failure;
  const recovery = f.gateway.invokeBrowser(browser.connectionId, "browser.getOperation", {
    sourceGrantId: browser.grant.grantId,
    invocationId,
  });
  const query = await browser.next((message) => message.kind === "host-request");
  assert.equal(query.method, "browser.getOperation");
  browser.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: browser.connectionId,
    requestId: query.requestId,
    invocationId: query.invocationId,
    method: query.method,
    ok: true,
    result: {
      invocationId,
      sourceGrantId: browser.grant.grantId,
      status: "applied",
      resultDigest: "a".repeat(64),
      contentStatus: "available",
      receipt: { method: original.method, ok: true, result: { status: "opened", actionId: null } },
    },
  });
  assert.equal((await recovery).result.status, "applied");
});

test("重新登记 grant 后旧响应不能完成当前调用；Port EOF 清理 Core grant", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const pending = assert.rejects(
    f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
    { code: "STALE_GRANT" },
  );
  const request = await browser.next((message) => message.kind === "host-request");
  await browser.call(
    "registerHost",
    { extensionId: "browser/1", capabilities: ["browser.context/1"] },
    browser.authorization,
  );
  browser.send({
    apiMajor: 1,
    kind: "host-response",
    connectionId: browser.connectionId,
    requestId: request.requestId,
    invocationId: request.invocationId,
    method: request.method,
    ok: true,
    result: { page: null },
  });
  await pending;
  browser.child.stdin.end();
  assert.equal(await exited(browser.child), 0);
  await delay(20);
  assert.equal(f.gateway.status().connections.length, 0);
  assert(
    f.core.closeCalls.some(
      (call) => call.action === "connectionClosed" && call.connectionId === browser.connectionId,
    ),
  );
});

test("Core 大响应转换为有界错误帧；同 Port 换 connectionId 拒绝", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const result = await browser.call("getPublicEntry", {}, browser.authorization);
  assert.equal(result.error.code, "PAYLOAD_TOO_LARGE");
  browser.connectionId = randomUUID();
  browser.send({
    apiMajor: 1,
    connectionId: browser.connectionId,
    requestId: randomUUID(),
    method: "getWorkspace",
    params: {},
  });
  await exited(browser.child);
  assert.equal(f.core.calls.filter((call) => call.envelope.method === "getWorkspace").length, 0);
});

test("未经握手的 UDS 和旧代次 token 都不能访问 Core", async (t) => {
  const f = await fixture(t);
  const descriptor = readPrivateJson(f.gateway.descriptorPath);
  const socket = net.connect(descriptor.socketPath);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    encodeFrame({ kind: "transport-auth", token: "x".repeat(64), extensionOrigin: origin }),
  );
  await new Promise((resolve) => socket.once("close", resolve));
  assert.equal(f.core.calls.length, 0);
});

test("注册与撤销只管理自身清单，不覆盖或删除另一份 Host", async (t) => {
  const f = await fixture(t);
  const manifest = JSON.parse(fs.readFileSync(f.registration.manifestPath));
  assert.equal(manifest.type, "stdio");
  assert.equal(manifest.allowed_origins[0], origin);
  const saved = fs.readFileSync(f.registration.manifestPath);
  fs.writeFileSync(f.registration.manifestPath, "changed", { mode: 0o600 });
  assert.throws(() => unregisterNativeHost(f.registration), /NATIVE_REGISTRATION_CHANGED/);
  assert.equal(fs.readFileSync(f.registration.launcher, "utf8").includes("NODE_OPTIONS"), true);
  fs.writeFileSync(f.registration.manifestPath, saved, { mode: 0o600 });
  assert.throws(
    () =>
      registerNativeHost({
        extensionId: "a".repeat(32),
        browserDataDir: path.join(f.root, "daily-browser"),
        profileRoot: path.join(f.root, "other-profile"),
        electronExecutable: electron,
        hostScript: script,
        profileName: "test",
      }),
    /ISOLATED_BROWSER_REQUIRED/,
  );
});

test("Core反向grant归属或能力声明错配时不给Main反向调用权限", async (t) => {
  const f = await fixture(t);
  const browser = await f.browser().connected();
  const original = f.core.request.bind(f.core);
  let mismatch = "client";
  f.core.request = async (endpoint, method, input) => {
    const response = await original(endpoint, method, input);
    if (input?.envelope?.method === "registerHost") {
      if (mismatch === "client") response.result.owner.clientInstanceId = randomUUID();
      if (mismatch === "capability") response.result.capabilities = ["browser.selection/1"];
      if (mismatch === "extension") response.result.extensionId = "idea/1";
    }
    return response;
  };
  for (mismatch of ["client", "capability", "extension"]) {
    const result = await browser.call(
      "registerHost",
      { extensionId: "browser/1", capabilities: ["browser.context/1"] },
      browser.authorization,
    );
    assert.equal(result.error.code, "HOST_UNAVAILABLE");
    await assert.rejects(
      () => f.gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
      { code: "HOST_UNAVAILABLE" },
    );
    assert.deepEqual(f.gateway.status().connections[0].hostCapabilities, []);
  }
});
