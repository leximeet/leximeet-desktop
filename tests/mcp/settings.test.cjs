"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { AssistantSettings } = require("../../electron/services/mcp/settings.cjs");

function settings(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-settings-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "LexiMeet");
  const shim = path.join(root, "shim.cjs");
  fs.writeFileSync(electron, "bin");
  fs.writeFileSync(shim, "shim");
  const host = new AssistantSettings({
    core: { request: async () => ({ writeEnabled: false }) },
    gateway: {
      status: () => ({ running: true }),
      descriptorPath: path.join(root, "leximeet-mcp-test.json"),
    },
    profile: { root, name: "test" },
    electronExecutable: electron,
    shimPath: shim,
    homeDir: root,
    env: { PATH: "/no-such-bin" },
    projectDir: path.resolve(__dirname, "../.."),
  });
  host.testConnection = async () => ({ ok: true, tools: ["leximeet_help"] });
  return host;
}

test("测试连接不要求 clientId", async (t) => {
  const result = await settings(t).action({ action: "test" });
  assert.equal(result.test.ok, true);
  assert.deepEqual(result.test.tools, ["leximeet_help"]);
});

test("测试连接以外的写入仍校验客户端", async (t) => {
  await assert.rejects(() => settings(t).action({ action: "connect" }), /只支持/);
});
