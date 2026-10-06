"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { connectedSessionRoot } = require("./connected-session-path.cjs");
const SESSION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const MANAGED_DIRECTORIES = Object.freeze(["application", "desktop", "browser-extension"]);

function privateDirectory(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(directory) !== directory)
    throw new Error("拒绝回收软链接或非本轮真实目录");
  if (typeof process.getuid === "function" && stat.uid !== process.getuid())
    throw new Error("拒绝回收其他用户的隔离目录");
  if ((stat.mode & 0o077) !== 0) throw new Error("隔离目录权限不安全，保留资料供检查");
}
function readSmallJson(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024)
    throw new Error("隔离记录无效，不能据此回收资料");
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
function processExists(pid) {
  for (const identity of [pid, -pid]) {
    try {
      process.kill(identity, 0);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") return true;
    }
  }
  return false;
}

// 只回收一个已结束会话的三个自有大目录；日志和验收记录保留，不扫描或清理其他会话。
function reclaimConnectedSession(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id))
    throw new Error("--cleanup 只接受终端显示的完整会话 UUID，不能传入路径");
  const root = connectedSessionRoot();
  privateDirectory(root);
  const directory = path.join(root, id);
  privateDirectory(directory);
  const recordFile = path.join(directory, "acceptance.json");
  const record = readSmallJson(recordFile);
  if (
    record.format !== "leximeet.connected-acceptance/2" ||
    record.id !== id ||
    record.directory !== directory ||
    record.profileRoot !== path.join(directory, "desktop") ||
    record.browserDataDir !== path.join(directory, "desktop/browser-profile/chrome") ||
    record.extensionDir !== path.join(directory, "browser-extension")
  )
    throw new Error("隔离记录与会话目录不一致，拒绝回收");
  const recoveryFile = path.join(directory, "worker-exit.json");
  const recovery = fs.existsSync(recoveryFile) ? readSmallJson(recoveryFile) : null;
  if (!record.stoppedAt && !(recovery?.unexpected && recovery.cleanupErrors?.length === 0))
    throw new Error("会话未确认结束；请先退出本轮两个应用，再执行回收");
  const identities = [
    ...Object.values(record.processes || {}).map((item) => item.pid),
    record.browser?.pid,
    ...(recovery?.pids || []),
  ].filter((pid) => pid !== undefined && pid !== null);
  if (identities.some((pid) => !Number.isInteger(pid) || pid <= 1))
    throw new Error("进程记录无效，拒绝回收");
  if (identities.some(processExists)) throw new Error("会话进程仍在运行，拒绝回收");
  if (record.registration?.manifestPath && fs.existsSync(record.registration.manifestPath))
    throw new Error("本轮 Native 注册尚未撤销，保留环境供恢复");
  // 先检查所有目标再删除，避免记录损坏时只回收一半；顶层软链接一律拒绝。
  const targets = MANAGED_DIRECTORIES.map((name) => path.join(directory, name));
  for (const target of targets) {
    const stat = fs.lstatSync(target, { throwIfNoEntry: false });
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
      throw new Error("回收目标不是本轮真实目录");
  }
  const reclaimed = [];
  for (let index = 0; index < targets.length; index++) {
    if (!fs.existsSync(targets[index])) continue;
    fs.rmSync(targets[index], { recursive: true, force: false });
    reclaimed.push(MANAGED_DIRECTORIES[index]);
  }
  record.artifactsReclaimed = true;
  record.reclaimedDirectories = [
    ...new Set([...(record.reclaimedDirectories || []), ...reclaimed]),
  ];
  record.reclaimedAt = new Date().toISOString();
  record.dataRetained = false;
  const temporary = path.join(directory, `acceptance.cleanup.${randomUUID()}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  fs.renameSync(temporary, recordFile);
  return record;
}
module.exports = { reclaimConnectedSession };
