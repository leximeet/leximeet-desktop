"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { FocusEvidence, startFocusMonitor } = require("../helpers/macos-focus-monitor.cjs");
const event = (pid, group = pid) => ({
  type: "activation",
  pid,
  group,
  at: 100,
});

function fakeObserver(events = [], { observable = true, spawnError = false } = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: new PassThrough(),
    exitCode: null,
    signalCode: null,
  });
  child.finish = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.stdout.end();
    child.stderr.end();
    child.emit("close", code, signal);
  };
  child.kill = () => child.finish(null, "SIGKILL");
  child.stdin.on("data", () => {
    child.stdout.write(JSON.stringify({ type: "finished" }) + "\n");
    queueMicrotask(() => child.finish(0));
  });
  queueMicrotask(() => {
    if (spawnError) {
      child.emit("error", new Error("spawn ENOENT"));
      child.finish(-2);
      return;
    }
    child.stdout.write(JSON.stringify({ type: "ready", observable, pid: 900 }) + "\n");
    for (const value of events) child.stdout.write(JSON.stringify(value) + "\n");
  });
  return child;
}
const start = (child) =>
  startFocusMonitor({
    platform: "darwin",
    executable: "/fake",
    spawnProcess: () => child,
  });

test("launch 返回前的激活在登记 PID 后仍能检出", () => {
  const evidence = new FocusEvidence();
  evidence.observe(event(123));
  evidence.track(123);
  assert.equal(evidence.report(true).violations.length, 1);
});
test("操作者切换应用不误报，不把其他应用 PID 或正文写入最终报告", () => {
  const evidence = new FocusEvidence();
  evidence.track(123);
  evidence.observe({
    ...event(456),
    title: "私人窗口",
    application: "private",
  });
  const report = evidence.report(true);
  assert.deepEqual(report.violations, []);
  assert.equal(JSON.stringify(report).includes("私人窗口"), false);
  // 时间戳也可能恰好包含 456；隐私断言必须验证 PID 字段，不能误报数字子串。
  assert.equal(report.trackedPids.includes(456), false);
});
test("同一测试进程组的辅助应用激活也算违规", () => {
  const evidence = new FocusEvidence();
  evidence.track(123);
  evidence.observe(event(124, 123));
  assert.equal(evidence.report(true).violations[0].pid, 124);
});
test("监测输入和记录预算有界，非法 PID 不会变成通过证据", () => {
  const evidence = new FocusEvidence();
  assert.throws(() => evidence.track(0), /有效/);
  assert.throws(() => evidence.observe({ type: "activation", pid: "123", at: 1 }), /无效事件/);
  for (let i = 0; i < 4096; i++) evidence.observe(event(1));
  assert.throws(() => evidence.observe(event(1)), /有界预算/);
});
test("监测完整退出后保留启动期违规，重复 stop 不重复关闭进程", async () => {
  const monitor = await start(fakeObserver([event(123)]));
  monitor.track(123);
  const report = await monitor.stop();
  assert.equal(report.complete, true);
  assert.equal(report.violations.length, 1);
  assert.deepEqual(await monitor.stop(), report);
});
test("监测中途意外结束不能被当作没有抢焦点", async () => {
  const child = fakeObserver(),
    monitor = await start(child);
  child.finish(0);
  const report = await monitor.stop();
  assert.equal(report.complete, false);
  assert.match(report.error, /意外退出/);
});
test("前台环境不可观测和工具启动失败会在应用启动前拒绝", async () => {
  await assert.rejects(start(fakeObserver([], { observable: false })), /不可观测/);
  await assert.rejects(start(fakeObserver([], { spawnError: true })), /ENOENT/);
});
test("尚未实现的系统平台明确报告边界，不冒称完成 macOS 焦点验收", async () => {
  const monitor = await startFocusMonitor({ platform: "linux" });
  const report = await monitor.stop();
  assert.equal(report.supported, false);
  assert.equal(report.complete, false);
});
