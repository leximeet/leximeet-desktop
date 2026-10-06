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
    "../leximeet-desktop-core.git",
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
    // 让 Git 自己解析相对地址，覆盖两个平台的 HTTPS/SSH；init 不访问网络。
    git(sandbox, "remote", "add", "origin", "https://github.com/leximeet/leximeet-desktop.git");
    for (const base of [
      "https://github.com/leximeet/",
      "git@github.com:leximeet/",
      "https://gitee.com/leximeet/",
      "git@gitee.com:leximeet/",
    ]) {
      git(sandbox, "remote", "set-url", "origin", `${base}leximeet-desktop.git`);
      git(sandbox, "submodule", "init", "core-java");
      assert.equal(
        git(sandbox, "config", "submodule.core-java.url"),
        `${base}leximeet-desktop-core.git`,
        "Core 来源应跟随 Desktop 的平台和传输方式",
      );
      git(sandbox, "config", "--unset", "submodule.core-java.url");
    }
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
