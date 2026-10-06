"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { businessClock } = require("../../electron/services/business-clock.cjs");
test("隔离业务 Clock 可跨天推进，真实 Date.now 不变；非测试、外部路径、符号链接均拒绝", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-business-clock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "test-clock.json");
  const profile = { name: "test", coreDir: root };
  fs.writeFileSync(
    file,
    JSON.stringify({ instant: "2026-10-03T02:00:00Z", zone: "Asia/Shanghai" }),
    { mode: 0o600 },
  );
  const real = Date.now;
  const now = businessClock({ profile, file });
  assert.equal(now(), Date.parse("2026-10-03T02:00:00Z"));
  fs.writeFileSync(
    file,
    JSON.stringify({ instant: "2026-10-09T02:00:00Z", zone: "Asia/Shanghai" }),
  );
  assert.equal(now(), Date.parse("2026-10-09T02:00:00Z"));
  assert.equal(Date.now, real);
  assert.throws(() => businessClock({ profile: { ...profile, name: "local" }, file }), /隔离/);
  assert.throws(() => businessClock({ profile, file: path.join(root, "other.json") }), /隔离/);
  fs.renameSync(file, path.join(root, "actual.json"));
  fs.symlinkSync(path.join(root, "actual.json"), file);
  assert.throws(() => businessClock({ profile, file }), /无效/);
});
