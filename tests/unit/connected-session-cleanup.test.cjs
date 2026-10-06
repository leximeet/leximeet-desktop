"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { connectedSessionRoot } = require("../../scripts/lib/connected-session-path.cjs");
const { reclaimConnectedSession } = require("../../scripts/lib/connected-session-cleanup.cjs");
const { parseArguments } = require("../../scripts/lib/connected-readiness.cjs");
const launcher = require("../../scripts/accept-connected.cjs");

function fixture(t) {
  const root = connectedSessionRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const id = randomUUID(),
    directory = path.join(root, id);
  fs.mkdirSync(directory, { mode: 0o700 });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  for (const name of ["application", "desktop", "browser-extension", "logs"]) {
    fs.mkdirSync(path.join(directory, name), { mode: 0o700 });
    fs.writeFileSync(path.join(directory, name, "owned.txt"), name);
  }
  const record = {
    format: "leximeet.connected-acceptance/2",
    id,
    directory,
    profileRoot: path.join(directory, "desktop"),
    browserDataDir: path.join(directory, "desktop/browser-profile/chrome"),
    extensionDir: path.join(directory, "browser-extension"),
    processes: {},
    cleanupErrors: [],
    stoppedAt: new Date().toISOString(),
  };
  const write = () =>
    fs.writeFileSync(path.join(directory, "acceptance.json"), JSON.stringify(record), {
      mode: 0o600,
    });
  write();
  return { id, directory, record, write };
}

test("结束会话只回收三处大目录，保留日志和记录，重复回收安全", (t) => {
  const f = fixture(t);
  const outside = fixture(t);
  f.record.application = { resources: path.join(outside.directory, "application") };
  f.write();
  const result = reclaimConnectedSession(f.id);
  assert.equal(result.artifactsReclaimed, true);
  assert.equal(result.dataRetained, false);
  assert.deepEqual(result.reclaimedDirectories, ["application", "desktop", "browser-extension"]);
  for (const name of result.reclaimedDirectories)
    assert.equal(fs.existsSync(path.join(f.directory, name)), false);
  assert.equal(fs.readFileSync(path.join(f.directory, "logs/owned.txt"), "utf8"), "logs");
  assert.equal(fs.existsSync(path.join(f.directory, "acceptance.json")), true);
  assert.equal(fs.existsSync(path.join(outside.directory, "application/owned.txt")), true);
  assert.equal(reclaimConnectedSession(f.id).artifactsReclaimed, true);
});
test("运行会话和已写结束标记但仍有进程的会话都拒绝回收", (t) => {
  const f = fixture(t);
  delete f.record.stoppedAt;
  f.write();
  assert.throws(() => reclaimConnectedSession(f.id), /未确认结束/);
  f.record.stoppedAt = new Date().toISOString();
  f.record.processes.desktop = { pid: process.pid };
  f.write();
  assert.throws(() => reclaimConnectedSession(f.id), /仍在运行/);
  assert.equal(fs.existsSync(path.join(f.directory, "application/owned.txt")), true);
});
test("未撤销注册不能回收；不替用户删除注册来掩盖退出失败", (t) => {
  const f = fixture(t);
  f.record.registration = { manifestPath: path.join(f.directory, "desktop/owned.txt") };
  f.write();
  assert.throws(() => reclaimConnectedSession(f.id), /注册尚未撤销/);
  assert.equal(fs.existsSync(f.record.registration.manifestPath), true);
});
test("异常 Worker 的已完成恢复允许显式回收，恢复失败仍保留", (t) => {
  const f = fixture(t);
  delete f.record.stoppedAt;
  f.write();
  const file = path.join(f.directory, "worker-exit.json");
  fs.writeFileSync(file, JSON.stringify({ unexpected: true, pids: [], cleanupErrors: ["未退出"] }));
  assert.throws(() => reclaimConnectedSession(f.id), /未确认结束/);
  fs.writeFileSync(file, JSON.stringify({ unexpected: true, pids: [], cleanupErrors: [] }));
  assert.equal(reclaimConnectedSession(f.id).artifactsReclaimed, true);
  assert.equal(fs.existsSync(file), true);
});
test("损坏或不属于本轮的记录拒绝回收，不能传入任意路径", (t) => {
  const f = fixture(t);
  for (const id of ["../escape", f.directory, "*", ""])
    assert.throws(() => reclaimConnectedSession(id), /完整会话 UUID/);
  f.record.profileRoot = path.dirname(f.directory);
  f.write();
  assert.throws(() => reclaimConnectedSession(f.id), /不一致/);
  assert.equal(fs.existsSync(path.join(f.directory, "application/owned.txt")), true);
});
test("目录或回收目标的软链接拒绝处理，外部文件保持不变", (t) => {
  const f = fixture(t),
    outside = fixture(t);
  fs.rmSync(path.join(f.directory, "browser-extension"), { recursive: true });
  fs.symlinkSync(
    path.join(outside.directory, "browser-extension"),
    path.join(f.directory, "browser-extension"),
  );
  assert.throws(() => reclaimConnectedSession(f.id), /真实目录/);
  assert.equal(fs.existsSync(path.join(f.directory, "application/owned.txt")), true);
  assert.equal(fs.existsSync(path.join(outside.directory, "browser-extension/owned.txt")), true);
});
test("cleanup CLI 不准备工具、不启动环境且不接受其他操作", async () => {
  const id = randomUUID();
  assert.deepEqual(parseArguments(["--cleanup", id]).sessionId, id);
  for (const args of [
    ["--cleanup"],
    ["--cleanup", "../x"],
    ["--cleanup", id, "--check"],
    ["--cleanup", id, "--extension", "/tmp"],
  ])
    assert.throws(() => parseArguments(args));
  let reclaimed;
  const result = await launcher.main(["--cleanup", id], {
    start() {
      throw new Error("不能启动");
    },
    checkReadiness() {
      throw new Error("不能读取构建");
    },
    reclaimConnectedSession(value) {
      reclaimed = value;
      return { directory: "已校验目录" };
    },
  });
  assert.equal(reclaimed, id);
  assert.equal(result.directory, "已校验目录");
});
