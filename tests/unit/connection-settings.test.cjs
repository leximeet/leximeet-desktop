"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { ConnectionSettings } = require("../../electron/services/connection-settings.cjs");
const id = "00000000-0000-4000-8000-000000000001";
function fixture(name = "test") {
  const calls = [];
  const gateway = {
    manage: async (input) => {
      calls.push(input);
      return { clients: [], workspaceId: id };
    },
    status: () => ({
      running: true,
      lastError: null,
      connections: [],
      descriptorPath: "private",
    }),
    refreshRegistrations: async () => calls.push("refreshRegistrations"),
  };
  const manager = new ConnectionSettings({
    gateway,
    profile: { name, root: "/tmp/leximeet-test" },
    homeDir: "/Users/test",
    electronExecutable: "/bundle/Electron",
    hostScript: "/bundle/host.cjs",
    platform: "darwin",
    register: (input) => {
      calls.push(input);
      return { origin: `chrome-extension://${input.extensionId}/` };
    },
  });
  return { calls, manager };
}
test("连接设置拒绝任意路径、内部清理动作和无效设备", async () => {
  const { manager, calls } = fixture();
  for (const input of [
    {
      action: "registerHost",
      extensionId: "a".repeat(32),
      browser: "chrome",
      browserDataDir: "/daily",
    },
    { action: "connectionClosed", connectionId: id },
    { action: "revoke" },
    { action: "disconnect", clientInstanceId: "any" },
    { action: "requestConnection", clientInstanceId: "any" },
    { action: "cancelInvitation", invitationId: "any" },
  ])
    await assert.rejects(() => manager.action(input));
  assert.deepEqual(calls, []);
});
test("发现来源可有尾斜杠，发邀请归一化精确来源并拒绝附加路径", async () => {
  const { manager, calls } = fixture();
  const origin = `chrome-extension://${"a".repeat(32)}`;
  for (const value of [origin, `${origin}/`]) {
    await manager.action({
      action: "requestConnection",
      clientInstanceId: id,
      origin: value,
    });
    assert.deepEqual(calls.at(-1), {
      action: "requestConnection",
      clientInstanceId: id,
      origin,
    });
  }
  const accepted = calls.length;
  for (const value of [
    `${origin}/page`,
    `${origin}?x=1`,
    `https://${"a".repeat(32)}`,
    `chrome-extension://${"z".repeat(32)}`,
  ])
    await assert.rejects(
      manager.action({
        action: "requestConnection",
        clientInstanceId: id,
        origin: value,
      }),
      /来源无效/,
    );
  assert.equal(calls.length, accepted);
});
test("测试和演示注册固定到各自目录，不能碰日常浏览器", async () => {
  for (const name of ["test", "demo", "dev", "preview"]) {
    const { manager, calls } = fixture(name);
    assert.deepEqual(
      await manager.action({
        action: "registerHost",
        extensionId: "a".repeat(32),
        browser: "chrome",
      }),
      {
        registered: true,
        browser: "chrome",
        extensionId: "a".repeat(32),
        isolated: true,
      },
    );
    assert.equal(calls[0].browserDataDir, "/tmp/leximeet-test/browser-profile/chrome");
    assert.equal(calls[0].allowDailyRegistration, false);
  }
});
test("正式用户明确点击注册才写本用户浏览器，状态不泄露密钥路径", async () => {
  const { manager, calls } = fixture("local");
  await manager.action({
    action: "registerHost",
    extensionId: "b".repeat(32),
    browser: "edge",
  });
  assert.equal(calls[0].browserDataDir, "/Users/test/Library/Application Support/Microsoft Edge");
  assert.equal(calls[0].allowDailyRegistration, true);
  const state = await manager.action({ action: "state" });
  assert.deepEqual(state.transport, {
    running: true,
    lastError: null,
    connections: [],
  });
  assert.equal(JSON.stringify(state).includes("descriptorPath"), false);
  await manager.action({ action: "disconnect", clientInstanceId: id });
  assert.deepEqual(calls.at(-1), {
    action: "disconnect",
    clientInstanceId: id,
  });
  await manager.action({ action: "requestConnection", clientInstanceId: id });
  assert.deepEqual(calls.at(-1), {
    action: "requestConnection",
    clientInstanceId: id,
  });
  await manager.action({ action: "cancelInvitation", invitationId: id });
  assert.deepEqual(calls.at(-1), {
    action: "cancelInvitation",
    invitationId: id,
  });
});
