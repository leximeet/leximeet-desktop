"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBusinessClock } = require("../helpers/business-clock.cjs");

function profile(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-clock-unit-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("测试业务时钟原子推进后新读者可见；旧句柄完整，不影响系统时间", (t) => {
  const directory = profile(t),
    before = Date.now();
  const clock = createBusinessClock(directory);
  const reader = fs.openSync(clock.file, "r");
  t.after(() => fs.closeSync(reader));
  clock.advanceDays(3);
  assert.equal(JSON.parse(fs.readFileSync(clock.file, "utf8")).instant, "2026-10-08T02:00:00.000Z");
  assert.equal(JSON.parse(fs.readFileSync(reader, "utf8")).instant, "2026-10-05T02:00:00.000Z");
  assert.ok(Date.now() >= before && Date.now() - before < 5000);
  assert.equal(fs.statSync(clock.file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(clock.file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(clock.file)), ["test-clock.json"]);
});

test("拒绝倒退、错误日期和覆写既有旅程，失败保留当前有效时间", (t) => {
  const directory = profile(t),
    clock = createBusinessClock(directory);
  clock.advanceDays(1);
  const prior = fs.readFileSync(clock.file, "utf8");
  assert.throws(() => clock.advanceTo("2026-10-05T02:00:00Z"), /不能倒退/);
  assert.throws(() => clock.advanceTo("not-a-date"), /ISO 时间/);
  assert.throws(() => createBusinessClock(directory), /已经存在/);
  assert.equal(fs.readFileSync(clock.file, "utf8"), prior);
});

test("拒绝被替换为符号链接的测试文件，外部内容不被覆盖", (t) => {
  const directory = profile(t),
    clock = createBusinessClock(directory);
  const external = path.join(directory, "outside.txt");
  fs.writeFileSync(external, "unchanged");
  fs.unlinkSync(clock.file);
  fs.symlinkSync(external, clock.file);
  assert.throws(() => clock.advanceDays(1), /符号链接/);
  assert.equal(fs.readFileSync(external, "utf8"), "unchanged");
});
