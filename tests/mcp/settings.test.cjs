"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { AssistantSettings } = require("../../electron/services/mcp/settings.cjs");

function settings() {
  const host = new AssistantSettings({
    core: { request: async () => ({ writeEnabled: false }) },
    gateway: { status: () => ({ running: true }), descriptorPath: "/tmp/leximeet-mcp-test.json" },
    profile: { root: "/tmp/leximeet-mcp-profile", name: "test" },
    electronExecutable: "/tmp/LexiMeet",
    shimPath: "/tmp/shim.cjs",
    homeDir: "/tmp/home",
  });
  host.testConnection = async () => ({ ok: true, tools: ["leximeet_help"] });
  return host;
}

test("测试连接不要求 clientId", async () => {
  const result = await settings().action({ action: "test" });
  assert.equal(result.test.ok, true);
  assert.deepEqual(result.test.tools, ["leximeet_help"]);
});

test("测试连接以外的写入仍校验客户端", async () => {
  await assert.rejects(() => settings().action({ action: "connect" }), /只支持/);
});
