"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeCursor, launchConfig } = require("../../electron/services/mcp/client-config.cjs");

test("客户端配置只写启动脚本，不含 --run-as-node 或 Core 令牌", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "electron");
  const shim = path.join(root, "shim.cjs");
  fs.writeFileSync(electron, "bin");
  fs.writeFileSync(shim, "shim");
  const file = path.join(root, "mcp.json");
  const launch = launchConfig(electron, shim, root);
  writeCursor(file, launch);
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /Bearer|127\.0\.0\.1:\d+|sqlite|token|--run-as-node/i);
  assert.match(text, /leximeet-mcp/);
  assert.match(fs.readFileSync(launch.command, "utf8"), /export ELECTRON_RUN_AS_NODE=1/);
});

test("目录快照拒绝复习提交工具", () => {
  const snapshot = require("../../resources/mcp/tools-snapshot.json");
  assert.equal(
    snapshot.tools.some((tool) => /review/i.test(tool.name)),
    false,
  );
});
