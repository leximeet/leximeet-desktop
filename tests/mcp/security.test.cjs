"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { writeCursor, launchConfig } = require("../../electron/services/mcp/client-config.cjs");

test("客户端配置不写入 Core 令牌或端口", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-mcp-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const electron = path.join(root, "electron");
  const shim = path.join(root, "shim.cjs");
  fs.writeFileSync(electron, "bin");
  fs.writeFileSync(shim, "shim");
  const file = path.join(root, "mcp.json");
  writeCursor(file, launchConfig(electron, shim, "cursor"));
  const text = fs.readFileSync(file, "utf8");
  assert.doesNotMatch(text, /Bearer|127\.0\.0\.1:\d+|sqlite|token/i);
  assert.match(text, /--run-as-node/);
});

test("目录快照拒绝复习提交工具", () => {
  const snapshot = require("../../resources/mcp/tools-snapshot.json");
  assert.equal(
    snapshot.tools.some((tool) => /review/i.test(tool.name)),
    false,
  );
});
