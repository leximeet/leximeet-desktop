"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { once } = require("node:events");
const { LmcpGateway } = require("../../electron/services/lmcp/gateway.cjs");
const { FrameDecoder, encodeFrame } = require("../../electron/services/lmcp/framing.cjs");
const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
const { IDEA_ORIGIN } = require("../../electron/services/lmcp/idea-binding.cjs");
const { ConnectionSettings } = require("../../electron/services/connection-settings.cjs");

const browser = "chrome-extension://" + "a".repeat(32) + "/";

test(
  "IDEA 与浏览器各用自己的传输密钥，Main 只放行 IDEA 的阅读控制面",
  {
    timeout: 10000,
    skip: process.platform === "win32" ? "IDEA 首版使用 Unix Domain Socket" : false,
  },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-idea-"));
    const calls = [];
    const gateway = new LmcpGateway({
      profile: { root, name: "test" },
      allowedOrigins: [browser],
      core: {
        async request(endpoint, _, data) {
          if (endpoint.endsWith("manage")) return data;
          const { envelope, extensionOrigin } = data;
          calls.push({ origin: extensionOrigin, method: envelope.method });
          return {
            requestId: envelope.requestId,
            connectionId: envelope.connectionId,
            method: envelope.method,
            apiVersion: "1.0.0",
            ok: true,
            result: {},
          };
        },
      },
    });
    const sockets = [];
    t.after(async () => {
      for (const socket of sockets) socket.destroy();
      await gateway.close();
      assert(!fs.existsSync(gateway.ideaBinding.descriptorPath));
      fs.rmSync(root, { recursive: true, force: true });
    });
    await gateway.start();
    const ideaFile = gateway.ideaBinding.descriptorPath;
    const idea = readPrivateJson(ideaFile);
    const chrome = readPrivateJson(gateway.descriptorPath);
    assert.notEqual(idea.token, chrome.token);
    assert.equal(fs.statSync(ideaFile).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(ideaFile)).mode & 0o777, 0o700);
    assert.equal(idea.format, "leximeet.idea-uds/1");

    async function dial(auth) {
      const socket = net.connect(idea.socketPath);
      sockets.push(socket);
      const decoder = new FrameDecoder();
      socket.on("error", () => {});
      socket.on("data", (bytes) => decoder.push(bytes));
      await once(socket, "connect");
      const connectionId = randomUUID();
      const next = () =>
        new Promise((resolve) => {
          const receive = (value) => {
            socket.off("close", closed);
            resolve(value);
          };
          const closed = () => {
            decoder.off("message", receive);
            resolve(null);
          };
          decoder.once("message", receive);
          socket.once("close", closed);
        });
      const pending = next();
      socket.write(encodeFrame(auth));
      return {
        ready: await pending,
        request(method) {
          const result = next();
          socket.write(
            encodeFrame({ apiMajor: 1, connectionId, requestId: randomUUID(), method, params: {} }),
          );
          return result;
        },
      };
    }
    assert.equal((await dial({ kind: "idea-transport-auth", token: chrome.token })).ready, null);
    assert.equal(
      (await dial({ kind: "transport-auth", token: idea.token, extensionOrigin: browser })).ready,
      null,
    );
    assert.equal(
      (await dial({ kind: "idea-transport-auth", token: idea.token, extensionOrigin: browser }))
        .ready,
      null,
    );
    const ide = await dial({ kind: "idea-transport-auth", token: idea.token });
    const native = await dial({
      kind: "transport-auth",
      token: chrome.token,
      extensionOrigin: browser,
    });
    assert.equal(ide.ready.instanceId, idea.instanceId);
    assert.equal(native.ready.instanceId, idea.instanceId);
    assert.equal((await ide.request("hello")).ok, true);
    assert.equal((await native.request("hello")).ok, true);
    assert.equal((await ide.request("matchWords")).ok, true);
    assert.equal((await ide.request("recordEncounter")).error.code, "FORBIDDEN");
    assert.equal((await ide.request("registerHost")).error.code, "FORBIDDEN");
    assert.equal((await native.request("recordEncounter")).ok, true);
    assert.deepEqual(calls, [
      { origin: IDEA_ORIGIN, method: "hello" },
      { origin: browser, method: "hello" },
      { origin: IDEA_ORIGIN, method: "matchWords" },
      { origin: browser, method: "recordEncounter" },
    ]);
    gateway.removeAllowedOrigin(browser);
    assert.equal((await ide.request("getWorkspace")).ok, true);
  },
);

test("桌面设置只允许发起到已知绑定，任意 IDE 来源会被拒绝", async () => {
  const settings = new ConnectionSettings({ gateway: { manage: async (input) => input } });
  const input = {
    action: "requestConnection",
    clientInstanceId: randomUUID(),
    origin: IDEA_ORIGIN,
  };
  assert.deepEqual(await settings.action(input), input);
  await assert.rejects(
    settings.action({ ...input, origin: "jetbrains://unknown" }),
    /插件来源无效/,
  );
});
