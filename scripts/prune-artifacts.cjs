"use strict";
const fs = require("node:fs");
const path = require("node:path");
const defaultRoot = path.resolve(__dirname, "..");

// 只回收可重建包；证据、日志、交接、依赖缓存和用户资料均不在清理集合内。
function pruneArtifacts({
  root = defaultRoot,
  workspacePackages = true,
  packageVerify = true,
  release = false,
  dryRun = false,
} = {}) {
  root = path.resolve(root);
  const removed = [],
    planned = [];
  // 在任何删除前检查所有路径；拒绝符号链接，避免穿过其他工作区。
  function check(target) {
    let current = root;
    for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
      if (part === "..") throw new Error("清理路径越界");
      current = path.join(current, part);
      if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink())
        throw new Error("清理拒绝符号链接路径");
    }
  }
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error("清理拒绝符号链接根目录");
  const lock = path.join(root, ".runtime/workspace-verification.lock");
  check(lock);
  if (fs.existsSync(lock)) throw new Error("验收运行锁存在，禁止清理；先核对运行已结束");
  const isBundle = (name) =>
    /^(?:mac(?:-|$)|win(?:-|$)|linux(?:-|$))/.test(name) ||
    /\.(?:app|dmg|zip|exe|AppImage|blockmap|bin)$/.test(name);
  const scan = (dir) => {
    check(dir);
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      const target = path.join(dir, name);
      check(target);
      if (isBundle(name)) planned.push(target);
    }
  };
  if (workspacePackages) {
    const workspace = path.join(root, "test-results/workspace");
    check(workspace);
    if (fs.existsSync(workspace))
      for (const name of fs.readdirSync(workspace)) scan(path.join(workspace, name, "package"));
  }
  if (packageVerify) scan(path.join(root, ".runtime/package-verify"));
  if (release) scan(path.join(root, "release"));
  // 预览与执行共用完整路径检查，预览不修改任何文件。
  if (dryRun) return planned;
  for (const target of planned) {
    fs.rmSync(target, { recursive: true, force: true });
    removed.push(target);
  }
  return removed;
}
if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  if (
    [...args].some(
      (arg) => !["--skip-workspace", "--skip-runtime", "--release", "--dry-run"].includes(arg),
    )
  )
    throw new Error("未知清理参数");
  const removed = pruneArtifacts({
    workspacePackages: !args.has("--skip-workspace"),
    packageVerify: !args.has("--skip-runtime"),
    release: args.has("--release"),
    dryRun: args.has("--dry-run"),
  });
  console.log(
    `${args.has("--dry-run") ? "可回收" : "已删除"} ${removed.length} 个可重建包，保留验收证据`,
  );
  for (const item of removed) console.log(`  ${item}`);
}
module.exports = { pruneArtifacts };
