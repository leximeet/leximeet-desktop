"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { sourceState } = require("./lib/build-manifest.cjs");
const { resolvePackageOutput, savePackagePointer } = require("./lib/package-output.cjs");
const { recordPackageCheck } = require("./record-package-check.cjs");
const root = path.resolve(__dirname, "..");
let builtCandidate;

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`${path.basename(command)} 检查未通过`);
}

// 只生成并验收本地安装文件；没有远端发布、安装到 Applications 或清个人资料的步骤。
function main() {
  const expectedSources = {
    desktop: sourceState(root),
    core: sourceState(path.join(root, "core-java")),
  };
  for (const directory of [root, path.join(root, "core-java")]) {
    const state = sourceState(directory);
    if (!state.commit || state.dirty !== false)
      throw new Error(
        "release:local 要求已提交的 Desktop / Core checkout；源码归档和开发调试可用 package:dir / package:dist，清单如实记录来源状态",
      );
  }
  const link = spawnSync("git", ["rev-parse", "HEAD:core-java"], { cwd: root, encoding: "utf8" });
  if (link.status !== 0 || link.stdout.trim() !== sourceState(path.join(root, "core-java")).commit)
    throw new Error("Core checkout 与 Desktop 固定 gitlink 不一致，请先同步并提交");
  const npm = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  for (const script of [
    "format:check",
    "docs:check",
    "verify:lmcp:contract",
    "test:unit",
    "test:core",
    "package:dist",
  ])
    run(npm, ["run", script]);
  run(process.env.LEXIMEET_PYTHON || (process.platform === "win32" ? "python" : "python3"), [
    "core-java/scripts/verify-release.py",
  ]);
  const directory = resolvePackageOutput(root);
  const manifestPath = path.join(directory, "BUILD-MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  builtCandidate = { directory, version: manifest.version };
  try {
    run(npm, ["run", "test:install"]);
    recordPackageCheck(directory, "install", "passed");
  } catch (error) {
    recordPackageCheck(directory, "install", "failed");
    throw error;
  }
  const finalSources = {
    desktop: sourceState(root),
    core: sourceState(path.join(root, "core-java")),
  };
  if (
    JSON.stringify(finalSources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(manifest.sources) !== JSON.stringify(expectedSources)
  )
    throw new Error("发布检查期间源码发生变化，请重新验收同一提交的完整候选");
  console.log(`本地安装候选及隔离启动检查完成：${directory}`);
  console.log("请安装本目录的安装器；签名、公证、系统权限及正式发布见 docs/本地打包与安装.md。");
}

try {
  main();
} catch (error) {
  // 安装验收或来源检查失败后，不让默认工具继续选择这份候选。
  if (builtCandidate)
    savePackagePointer(root, builtCandidate.directory, builtCandidate.version, "failed");
  console.error(error.message);
  process.exitCode = 1;
}
