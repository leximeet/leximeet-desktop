"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { randomUUID } = require("node:crypto");
const { LmcpGateway } = require("../../electron/services/lmcp/gateway.cjs");
const { FrameDecoder, encodeFrame } = require("../../electron/services/lmcp/framing.cjs");
const { readPrivateJson } = require("../../electron/services/lmcp/private-files.cjs");
const origin = `chrome-extension://${"a".repeat(32)}/`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fixture(t, options) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lmcp-gateway-test-"));
  const gateway = new LmcpGateway({
    profile: { root, name: "test" },
    allowedOrigins: [origin],
    ...options,
  });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await gateway.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await gateway.start();
  const descriptor = readPrivateJson(gateway.descriptorPath);
  async function client(connectionId = randomUUID()) {
    const socket = net.connect(descriptor.socketPath);
    sockets.push(socket);
    const decoder = new FrameDecoder();
    const inbox = [];
    const waiting = [];
    decoder.on("message", (message) => {
      if (waiting.length) waiting.shift()(message);
      else inbox.push(message);
    });
    decoder.on("error", () => socket.destroy());
    socket.on("data", (data) => decoder.push(data));
    socket.on("error", () => {});
    await new Promise((resolve) => socket.once("connect", resolve));
    const next = () =>
      inbox.length
        ? Promise.resolve(inbox.shift())
        : new Promise((resolve) => waiting.push(resolve));
    socket.write(
      encodeFrame({ kind: "transport-auth", token: descriptor.token, extensionOrigin: origin }),
    );
    assert.equal((await next()).kind, "transport-ready");
    return {
      socket,
      next,
      connectionId,
      send(method, params = {}, authorization) {
        const envelope = { apiMajor: 1, connectionId, requestId: randomUUID(), method, params };
        if (authorization) envelope.authorization = authorization;
        socket.write(encodeFrame(envelope));
      },
    };
  }
  return { gateway, client };
}

test(
  "awaitReady 超时有界，仍未结束的 Core 任务不释放实际并发额度",
  { timeout: 10000 },
  async (t) => {
    let release;
    const ready = new Promise((resolve) => {
      release = resolve;
    });
    const core = {
      async request(endpoint, _, { envelope }) {
        if (endpoint.endsWith("manage")) return {};
        return {
          apiVersion: "1.0.0",
          requestId: envelope.requestId,
          connectionId: envelope.connectionId,
          method: envelope.method,
          ok: true,
          result: {},
        };
      },
    };
    const f = await fixture(t, { core, awaitReady: () => ready, forwardTimeoutMs: 15 });
    const clients = await Promise.all(Array.from({ length: 4 }, () => f.client()));
    for (const client of clients) client.send("hello");
    assert(
      (await Promise.all(clients.map((client) => client.next()))).every(
        (result) => result.error.code === "DEADLINE_EXCEEDED",
      ),
    );
    for (const client of clients) for (let i = 0; i < 7; i++) client.send("getWorkspace");
    const results = await Promise.all(
      clients.flatMap((client) => Array.from({ length: 7 }, () => client.next())),
    );
    assert(results.every((result) => result.error.code === "DEADLINE_EXCEEDED"));
    assert.equal(f.gateway.status().activeRequests, 32);
    clients[0].send("getWorkspace");
    assert.equal((await clients[0].next()).error.code, "RATE_LIMITED");
    release();
    await delay(20);
    assert.equal(f.gateway.status().activeRequests, 0);
  },
);

test("断线清理请求不返回时 close 在指定期限结束，报告未确认", { timeout: 5000 }, async (t) => {
  const core = {
    async request(endpoint, _, { envelope }) {
      if (endpoint.endsWith("manage")) return new Promise(() => {});
      return {
        apiVersion: "1.0.0",
        requestId: envelope.requestId,
        connectionId: envelope.connectionId,
        method: envelope.method,
        ok: true,
        result: {},
      };
    },
  };
  const f = await fixture(t, { core, cleanupTimeoutMs: 30 });
  const client = await f.client();
  client.send("hello");
  assert.equal((await client.next()).ok, true);
  const started = Date.now();
  await f.gateway.close();
  assert(Date.now() - started < 1000);
  assert.equal(f.gateway.status().lastError, "断线授权清理未确认");
});

test("先超时再真实提交的写入仍向本机页面发出资料失效通知", async (t) => {
  let changed = 0;
  const core = {
    async request(endpoint, _, { envelope }) {
      if (endpoint.endsWith("manage")) return {};
      if (envelope.method === "recordEncounter") await delay(60);
      return {
        apiVersion: "1.0.0",
        requestId: envelope.requestId,
        connectionId: envelope.connectionId,
        method: envelope.method,
        ok: true,
        result: {},
      };
    },
  };
  const f = await fixture(t, { core, forwardTimeoutMs: 15, onDataChanged: () => changed++ });
  const client = await f.client();
  client.send("hello");
  assert.equal((await client.next()).ok, true);
  client.send("recordEncounter");
  const result = await client.next();
  assert.equal(result.error.code, "DEADLINE_EXCEEDED");
  assert.equal(result.error.resultUnknown, true);
  assert.equal(changed, 0);
  await delay(70);
  assert.equal(changed, 1);
});

test("Core成功回执超帧时写入仍标记结果未知，读取超帧不冒充已提交业务", async (t) => {
  let changed = 0;
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) return {};
        return response(
          input.envelope,
          input.envelope.method === "hello" ? {} : { text: "x".repeat(262144) },
        );
      },
    },
    onDataChanged: () => changed++,
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  client.send("recordEncounter");
  const write = await client.next();
  assert.equal(write.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(write.error.resultUnknown, true);
  assert.equal(changed, 1);
  client.send("getPublicEntry");
  const read = await client.next();
  assert.equal(read.error.code, "PAYLOAD_TOO_LARGE");
  assert.equal(read.error.resultUnknown, undefined);
});

test("设置页管理调用在Core未就绪时有界，超时不释放真实并发额度", async (t) => {
  let release;
  const ready = new Promise((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    core: {
      async request() {
        return { clients: [] };
      },
    },
    awaitReady: () => ready,
    manageTimeoutMs: 15,
  });
  const results = await Promise.allSettled(
    Array.from({ length: 32 }, () => f.gateway.manage({ action: "state" })),
  );
  assert(
    results.every(
      (result) => result.status === "rejected" && result.reason.code === "DEADLINE_EXCEEDED",
    ),
  );
  assert.equal(f.gateway.status().activeRequests, 32);
  await assert.rejects(() => f.gateway.manage({ action: "state" }), { code: "RATE_LIMITED" });
  release();
  await delay(5);
  assert.equal(f.gateway.status().activeRequests, 0);
});

test("未确认断线清理占生命周期槽，禁止旧ID复用且后台清理数量有界", async (t) => {
  let cleanupCalls = 0;
  const core = {
    async request(endpoint, _, { envelope }) {
      if (endpoint.endsWith("manage")) {
        cleanupCalls++;
        return new Promise(() => {});
      }
      return {
        apiVersion: "1.0.0",
        requestId: envelope.requestId,
        connectionId: envelope.connectionId,
        method: envelope.method,
        ok: true,
        result: {},
      };
    },
  };
  const f = await fixture(t, { core, maxConnections: 2, cleanupTimeoutMs: 15 });
  for (let i = 0; i < 2; i++) {
    const client = await f.client();
    client.send("hello");
    assert.equal((await client.next()).ok, true);
    const closed = new Promise((resolve) => client.socket.once("close", resolve));
    client.socket.destroy();
    await closed;
    await delay(20);
    if (i === 0) {
      const reused = await f.client(client.connectionId);
      const rejected = new Promise((resolve) => reused.socket.once("close", resolve));
      reused.send("hello");
      await rejected;
      assert.equal(cleanupCalls, 1);
    }
  }
  assert.equal(cleanupCalls, 2);
  assert.equal(f.gateway.status().cleanupPendingCount, 2);
  const extra = await f.client();
  const closed = new Promise((resolve) => extra.socket.once("close", resolve));
  extra.send("hello");
  await closed;
  assert.equal(cleanupCalls, 2);
  assert.equal(f.gateway.status().connections.length, 0);
});

function response(envelope, result) {
  return {
    apiVersion: "1.0.0",
    requestId: envelope.requestId,
    connectionId: envelope.connectionId,
    method: envelope.method,
    ok: true,
    result,
  };
}
function delivery(envelope, pairingId = randomUUID()) {
  return {
    deliveryToken: "d".repeat(64),
    pairingId,
    mutationId: envelope.params.mutationId,
    connectionId: envelope.connectionId,
    target: "word",
    uiWordId: "resilient",
  };
}

test("未知旧方法不进入Core，正常rc.5方法仍可调用", async (t) => {
  const calls = [];
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) return {};
        calls.push(input.envelope.method);
        return response(input.envelope, {});
      },
    },
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  for (const method of [
    "createWord",
    "beginAttachment",
    "registerBrowserHost",
    "getPracticeQueue",
  ]) {
    client.send(method);
    assert.equal((await client.next()).error.code, "CAPABILITY_UNAVAILABLE");
  }
  client.send("matchWords");
  assert.equal((await client.next()).ok, true);
  assert.deepEqual(calls, ["hello", "matchWords"]);
});

test("导航首次私有令牌仅配送一次，真实UI确认后完成Core回执且不泄漏令牌", async (t) => {
  const completed = [];
  const issued = new Set();
  const pairingId = randomUUID();
  let opened = 0;
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) {
          completed.push(input);
          return { opened: input.opened };
        }
        const envelope = input.envelope;
        if (envelope.method !== "openInDesktop") return response(envelope, {});
        const key = envelope.params.mutationId;
        if (issued.has(key)) return response(envelope, { opened: false, navigationPending: true });
        issued.add(key);
        return response(envelope, {
          opened: false,
          navigationPending: true,
          navigationDelivery: delivery(envelope, pairingId),
        });
      },
    },
    onOpenInDesktop: async (_, result) => {
      assert.equal(result.navigationDelivery.uiWordId, "resilient");
      opened++;
      return { opened: true };
    },
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  const mutationId = randomUUID();
  for (let i = 0; i < 2; i++) {
    client.send("openInDesktop", { target: "library", mutationId });
    assert.deepEqual((await client.next()).result, { opened: i === 0 });
  }
  await delay(10);
  assert.equal(opened, 1);
  assert.deepEqual(completed, [
    {
      action: "completeNavigation",
      pairingId,
      mutationId,
      connectionId: client.connectionId,
      deliveryToken: "d".repeat(64),
      opened: true,
    },
  ]);
});

test("页面回调失败保留未知pending，不把成功采集或导航初始回执改报失败", async (t) => {
  let navigation;
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) return {};
        const envelope = input.envelope;
        return response(
          envelope,
          envelope.method === "openInDesktop"
            ? { opened: false, navigationDelivery: delivery(envelope) }
            : {},
        );
      },
    },
    onOpenInDesktop: async (_, result) => {
      navigation = result;
      throw new Error("页面失败");
    },
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  client.send("openInDesktop", { target: "library", mutationId: randomUUID() });
  assert.deepEqual((await client.next()).result, { opened: false });
  await delay(10);
  assert.equal(navigation.navigationDelivery.uiWordId, "resilient");
  assert.equal(f.gateway.status().lastError, "桌面页面打开未确认");
});

test("导航回调未结束时数量有界，不阻塞初始回执或退出", async (t) => {
  let calls = 0;
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) return {};
        return response(
          input.envelope,
          input.envelope.method === "openInDesktop"
            ? { opened: false, navigationDelivery: delivery(input.envelope) }
            : {},
        );
      },
    },
    maxOpenDeliveries: 2,
    navigationTimeoutMs: 10,
    onOpenInDesktop: () => {
      calls++;
      return new Promise(() => {});
    },
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  for (let i = 0; i < 3; i++) {
    client.send("openInDesktop", { target: "library", mutationId: randomUUID() });
    assert.deepEqual((await client.next()).result, { opened: false });
  }
  assert.equal(calls, 2);
  assert.equal(f.gateway.openDeliveries.size, 2);
  assert.equal(f.gateway.status().lastError, "桌面导航队列繁忙");
  await f.gateway.close();
});

test("导航等待有界，超时不释放仍在执行的配送，也不重复路由", async (t) => {
  let release;
  const ack = new Promise((resolve) => {
    release = resolve;
  });
  const completed = [];
  const issued = new Set();
  let routes = 0;
  const f = await fixture(t, {
    core: {
      async request(endpoint, _, input) {
        if (endpoint.endsWith("manage")) {
          completed.push(input);
          return { opened: input.opened };
        }
        const envelope = input.envelope;
        if (envelope.method !== "openInDesktop") return response(envelope, {});
        if (issued.has(envelope.params.mutationId))
          return response(envelope, { opened: false, navigationPending: true });
        issued.add(envelope.params.mutationId);
        return response(envelope, {
          opened: false,
          navigationPending: true,
          navigationDelivery: delivery(envelope),
        });
      },
    },
    navigationTimeoutMs: 10,
    onOpenInDesktop: async () => {
      routes++;
      await ack;
      return true;
    },
  });
  const client = await f.client();
  client.send("hello");
  await client.next();
  const mutationId = randomUUID();
  for (let i = 0; i < 2; i++) {
    client.send("openInDesktop", { target: "library", mutationId });
    assert.deepEqual((await client.next()).result, { opened: false });
  }
  assert.equal(routes, 1);
  assert.equal(f.gateway.openDeliveries.size, 1);
  assert.equal(completed.length, 0);
  release();
  await delay(10);
  assert.equal(completed.length, 1);
  assert.equal(completed[0].opened, true);
});
