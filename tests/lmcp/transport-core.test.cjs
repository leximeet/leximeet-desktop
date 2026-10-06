"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");
const { TextDictionaryService } = require("../../electron/services/text-dictionary.cjs");
const { LmcpGateway } = require("../../electron/services/lmcp/gateway.cjs");
const {
  PluginCaptureNotifications,
} = require("../../electron/services/plugin-capture-notifications.cjs");
const {
  registerNativeHost,
  unregisterNativeHost,
} = require("../../electron/services/lmcp/native-registration.cjs");
const { FrameDecoder, encodeFrame } = require("../../electron/services/lmcp/framing.cjs");
const { startFocusMonitor } = require("../helpers/macos-focus-monitor.cjs");
const project = path.resolve(__dirname, "../..");

// 真实 Java/Core SQLite + Main 私有 HTTP + UDS + 独立 Host；浏览器端仅模拟 stdio 客户端。
test("真实Core贯通1.0.0配对/采集幂等/桌面投影/重启恢复/撤权", { timeout: 90000 }, async (t) => {
  const contractPath =
    process.env.LEXIMEET_LMCP_CONTRACT || path.join(project, "resources", "lmcp", "contract.json");
  const jarPath =
    process.env.LEXIMEET_LMCP_CORE_JAR ||
    path.join(project, "core-java", "target", "leximeet-core.jar");
  assert(fs.existsSync(contractPath), "请先准备固定 LMCP 1.0.0 合同物料");
  assert(fs.existsSync(jarPath), "请先构建当前 LMCP Core，不能用旧 Jar 冒充通过");
  const contract = JSON.parse(fs.readFileSync(contractPath, "utf8"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-core-native-"));
  const profile = { name: "test", root: path.join(root, "desktop") };
  fs.mkdirSync(profile.root, { mode: 0o700 });
  profile.coreDir = path.join(profile.root, "core");
  const runtime = new JavaRuntime({ jarPath, dataDir: profile.coreDir });
  const dictionary = new TextDictionaryService({
    core: runtime,
    profile,
    bundledPath: path.join(project, "resources/dictionary"),
  });
  const origin = `chrome-extension://${"a".repeat(32)}/`;
  class SilentNotice extends EventEmitter {
    static isSupported() {
      return true;
    }
    show() {
      this.emit("show");
    }
    close() {
      this.emit("close");
    }
  }
  const notifications = new PluginCaptureNotifications({
    Notification: SilentNotice,
    profile,
    settings: async () => (await runtime.request("/api/settings")).settings,
  });
  const gateway = new LmcpGateway({
    core: runtime,
    profile,
    allowedOrigins: [origin],
    onCaptureCommitted: (value) => notifications.captureCommitted(value),
  });
  let registration;
  let focus;
  const children = [];
  t.after(async () => {
    try {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
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
                setTimeout(() => reject(new Error("Native 子进程清理超时")), 1500),
              ),
            ]);
          }
        }
      notifications.close();
      await gateway.close();
      await dictionary.close();
      await runtime.stop();
      if (registration && fs.existsSync(registration.recordPath))
        unregisterNativeHost(registration);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      if (focus) {
        const report = await focus.stop();
        t.diagnostic(`LMCP_CORE_FOCUS ${JSON.stringify(report)}`);
        assert.equal(report.complete, true, report.error || "焦点监测不完整");
        assert.deepEqual(report.violations, []);
      }
    }
  });
  focus = await startFocusMonitor({ root: project });
  await runtime.start();
  focus.track(runtime.child.pid);
  await dictionary.ensure();
  await gateway.start();
  registration = registerNativeHost({
    extensionId: "a".repeat(32),
    browserDataDir: path.join(root, "browser"),
    profileRoot: profile.root,
    electronExecutable: require("electron"),
    hostScript: path.join(project, "electron", "native-host", "main.cjs"),
    profileName: "test",
    isolated: true,
    hostName: "org.leximeet.browser.test",
  });
  const connect = () => {
    const child = spawn(registration.launcher, [origin], {
      env: { PATH: "/usr/bin:/bin" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    focus.track(child.pid);
    const decoder = new FrameDecoder();
    const awaiting = new Map();
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    decoder.on("error", (error) => {
      for (const item of awaiting.values()) item.reject(error);
    });
    decoder.on("message", (message) => {
      const item = awaiting.get(message.requestId);
      if (!item) return;
      awaiting.delete(message.requestId);
      clearTimeout(item.timer);
      item.resolve(message);
    });
    child.stdout.on("data", (data) => decoder.push(data));
    child.on("exit", () => {
      for (const item of awaiting.values()) {
        clearTimeout(item.timer);
        item.reject(new Error(`Native Host 退出 ${stderr}`));
      }
      awaiting.clear();
    });
    const connectionId = randomUUID();
    return {
      child,
      connectionId,
      call(method, params = {}, authorization) {
        const requestId = randomUUID();
        const envelope = { apiMajor: 1, requestId, connectionId, method, params };
        if (authorization) envelope.authorization = authorization;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            awaiting.delete(requestId);
            reject(new Error(`Core/Host 响应超时 ${method}`));
          }, 15000);
          awaiting.set(requestId, { resolve, reject, timer });
          child.stdin.write(encodeFrame(envelope));
        });
      },
    };
  };
  const clientInstanceId = randomUUID();
  const hello = async (browser) => {
    const response = await browser.call("hello", {
      apiMajor: 1,
      minApiVersion: "1.0.0",
      connectionId: browser.connectionId,
      contractVersion: contract.packageVersion,
      contractDigest: contract.contractDigest,
      clientKind: "browser",
      clientInstanceId,
      displayName: "Core隔离传输客户端",
      requiredCapabilities: contract.requiredCapabilities,
    });
    assert.equal(response.ok, true, JSON.stringify(response.error));
    assert.equal(response.result.contractDigest, contract.contractDigest);
  };
  const browser = connect();
  await hello(browser);
  await gateway.manage({ action: "requestConnection", clientInstanceId });
  const invitation = await browser.call("getConnectionStatus", { clientInstanceId });
  assert.equal(invitation.ok, true);
  const paired = await browser.call("pair", {
    invitationId: invitation.result.invitation.invitationId,
    invitationToken: invitation.result.invitation.invitationToken,
    clientInstanceId,
  });
  assert.equal(paired.ok, true, JSON.stringify(paired.error));
  assert(paired.result.scopes.includes("capture:write"));
  const authorization = paired.result.authorization;
  const credential = paired.result.pairingCredential;
  const workspace = await browser.call("getWorkspace", {}, authorization);
  assert.equal(workspace.ok, true);
  assert.equal(workspace.result.account.status, "unavailable");
  const customId = randomUUID();
  const word = { kind: "custom", customId, headword: "transport-isolated", language: "en" };
  const sentence = "Read transport-isolated today.";
  const start = sentence.indexOf(word.headword);
  const params = {
    eventId: randomUUID(),
    mutationId: randomUUID(),
    notebookId: null,
    data: {
      word,
      surface: word.headword,
      originalSentence: sentence,
      savedExcerpt: sentence,
      occurrenceRanges: [{ start, end: start + word.headword.length }],
      excerptRanges: [{ start, end: start + word.headword.length }],
      annotation: { note: "只存在本例" },
      source: { kind: "web", title: "隔离采集", url: "https://example.invalid/reading" },
      collectionIntent: "collect",
    },
  };
  const created = await browser.call("recordEncounter", params, authorization);
  assert.equal(created.ok, true, JSON.stringify(created.error));
  const repeated = await browser.call("recordEncounter", params, authorization);
  assert.deepEqual(repeated.result, created.result, "重试沿用原mutationId并返回原回执");
  await notifications.queue;
  assert.equal(notifications.snapshot().sentCount, 1, "真实 Core 成功采集通知一次，幂等重试不重复");
  const collision = await browser.call(
    "recordEncounter",
    {
      ...params,
      data: { ...params.data, annotation: { ...params.data.annotation, note: "另一个意图" } },
    },
    authorization,
  );
  assert.equal(collision.error.code, "IDEMPOTENCY_KEY_REUSED");
  await notifications.queue;
  assert.equal(notifications.snapshot().sentCount, 1, "失败采集不发送通知");
  const operation = await browser.call(
    "getOperation",
    { mutationId: params.mutationId },
    authorization,
  );
  assert.equal(operation.result.status, "applied");
  assert.deepEqual(operation.result.result, created.result);
  const read = await browser.call("getWord", { word }, authorization);
  assert.equal(read.ok, true, JSON.stringify(read.error));
  assert.equal(read.result.personal.note, "只存在本例");
  assert.equal(read.result.learning.score, 10);
  const changes = await browser.call(
    "getChanges",
    { sinceRevision: workspace.result.revision },
    authorization,
  );
  assert.equal(changes.ok, true);
  assert.equal(changes.result.changed, true);
  const local = await runtime.request("/api/desktop/query", "POST", {
    kind: "words",
    search: word.headword,
  });
  assert.equal(local.total, 1);
  assert.equal(local.words[0].word, word.headword);
  const encounters = await runtime.request("/api/desktop/query", "POST", {
    kind: "encounters",
    search: word.headword,
  });
  assert.equal(encounters.total, 1);
  assert.equal(encounters.encounters[0].context, sentence);
  const registered = await browser.call(
    "registerHost",
    { extensionId: "browser/1", capabilities: ["browser.context/1"] },
    authorization,
  );
  assert.equal(registered.ok, true, JSON.stringify(registered.error));
  // 真实重启 Java，旧 Port 仍存在；旧短 token 和 Main 缓存 grant 均不能跨运行代次继续授权。
  await runtime.stop();
  await runtime.start();
  focus.track(runtime.child.pid);
  await dictionary.ensure();
  await assert.rejects(
    () => gateway.invokeBrowser(browser.connectionId, "browser.getContext", {}),
    { code: "HOST_UNAVAILABLE" },
  );
  const oldSession = await browser.call("getWord", { word }, authorization);
  assert.equal(oldSession.ok, false);
  assert.equal(oldSession.error.code, "UNAUTHORIZED");
  const closed = new Promise((resolve) => browser.child.once("exit", resolve));
  browser.child.stdin.end();
  await closed;
  await Promise.allSettled([...gateway.cleanup]);
  const resumedBrowser = connect();
  await hello(resumedBrowser);
  const resumed = await resumedBrowser.call("resumeSession", credential);
  assert.equal(resumed.ok, true, JSON.stringify(resumed.error));
  assert.notEqual(resumed.result.authorization.sessionId, authorization.sessionId);
  const readAgain = await resumedBrowser.call("getWord", { word }, resumed.result.authorization);
  assert.equal(readAgain.ok, true);
  assert.equal(readAgain.result.personal.note, "只存在本例");
  const recordedAgain = await resumedBrowser.call(
    "recordEncounter",
    params,
    resumed.result.authorization,
  );
  assert.deepEqual(recordedAgain.result, created.result, "当前模型重启后仍保留原幂等回执");
  await notifications.queue;
  assert.equal(notifications.snapshot().sentCount, 1, "Core 重启后同一事件回执仍不重复通知");
  await gateway.manage({ action: "revoke", clientInstanceId });
  const revokedBrowser = connect();
  await hello(revokedBrowser);
  const revoked = await revokedBrowser.call("resumeSession", credential);
  assert.equal(revoked.ok, false);
  assert.equal(revoked.error.code, "PAIRING_REVOKED");
  assert(!JSON.stringify(gateway.status()).includes(runtime.token));
});
