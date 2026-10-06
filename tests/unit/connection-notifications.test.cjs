"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { ConnectionNotifications } = require("../../electron/services/connection-notifications.cjs");
class Notice extends EventEmitter {
  static isSupported() {
    return true;
  }
  constructor(value) {
    super();
    this.value = value;
  }
  show() {
    this.shown = true;
  }
  close() {
    this.emit("close");
  }
}
const client = {
  origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/",
  clientInstanceId: "00000000-0000-4000-8000-000000000001",
};
test("发现提醒去重，只有真实通知点击才创建邀请，通知无认证秘密", async () => {
  const calls = [];
  const service = new ConnectionNotifications({
    Notification: Notice,
    gateway: {
      manage: async (input) => {
        calls.push(input);
        return { clients: [] };
      },
    },
  });
  await service.discover(client);
  await service.discover(client);
  assert.equal(service.notices.size, 1);
  assert.deepEqual(calls, [{ action: "state" }]);
  const notice = [...service.notices.values()][0];
  assert.equal(notice.shown, true);
  assert(!JSON.stringify(notice.value).includes("Token"));
  notice.emit("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], {
    action: "requestConnection",
    clientInstanceId: client.clientInstanceId,
    origin: client.origin,
  });
  service.close();
});
test("临时重连不重复发现或成功通知，明确不把系统支持当成用户授权", async () => {
  const service = new ConnectionNotifications({
    Notification: Notice,
    gateway: {
      manage: async () => ({
        clients: [{ ...client, connectionState: "connected" }],
      }),
    },
  });
  await service.discover(client);
  assert.equal(service.notices.size, 0);
  client.owner = {
    pairingId: "00000000-0000-4000-8000-000000000002",
    authorizationEpoch: 1,
  };
  service.connectionReady(client);
  service.connectionReady(client);
  assert.equal(service.notices.size, 1);
  [...service.notices.values()][0].emit("failed");
  assert.match(service.snapshot().lastError, /未显示/);
  service.close();
});
test("Core探测暂时失败可以再次提醒，退出后旧通知不能发起连接", async () => {
  let unavailable = true,
    requested = 0;
  const service = new ConnectionNotifications({
    Notification: Notice,
    gateway: {
      manage: async (input) => {
        if (unavailable) throw new Error("not-ready");
        if (input.action === "requestConnection") requested++;
        return { clients: [] };
      },
    },
  });
  await assert.rejects(service.discover(client));
  unavailable = false;
  await service.discover(client);
  const notice = [...service.notices.values()][0];
  service.close();
  notice.emit("click");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested, 0);
});
test("同 client 在其他精确来源的连接不屏蔽当前发现通知", async () => {
  const service = new ConnectionNotifications({
    Notification: Notice,
    gateway: {
      manage: async () => ({
        clients: [
          {
            ...client,
            origin: `chrome-extension://${"b".repeat(32)}`,
            connectionState: "connected",
          },
        ],
      }),
    },
  });
  await service.discover(client);
  assert.equal(service.notices.size, 1);
  service.close();
});
