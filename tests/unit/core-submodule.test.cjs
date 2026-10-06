"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "../..");
const core = path.join(root, "core-java");
const git = (cwd, ...args) =>
  execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

test("Core 为固定提交的独立子模块，空检出可初始化相同源码", () => {
  assert.equal(
    git(root, "config", "-f", ".gitmodules", "submodule.core-java.url"),
    "https://github.com/leximeet/leximeet-desktop-core.git",
  );
  const entry = git(root, "ls-files", "--stage", "core-java");
  assert.match(entry, /^160000 [a-f0-9]{40} 0\tcore-java$/);
  const revision = entry.split(" ")[1];
  assert.equal(git(core, "rev-parse", "HEAD"), revision, "更新 Core 后必须显式更新 gitlink");
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-submodule-"));
  try {
    git(sandbox, "init", "--quiet");
    fs.copyFileSync(path.join(root, ".gitmodules"), path.join(sandbox, ".gitmodules"));
    git(sandbox, "add", ".gitmodules");
    git(sandbox, "update-index", "--add", "--cacheinfo", `160000,${revision},core-java`);
    // 只初始化本地测试源，不拉网络、不依赖尚未推送的提交，也不写开发者全局 Git 配置。
    git(sandbox, "config", "submodule.core-java.url", core);
    git(sandbox, "-c", "protocol.file.allow=always", "submodule", "update", "--init", "core-java");
    assert.equal(git(path.join(sandbox, "core-java"), "rev-parse", "HEAD"), revision);
    assert.ok(
      fs.existsSync(path.join(sandbox, "core-java/src/main/java/app/leximeet/core/Main.java")),
    );
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});
