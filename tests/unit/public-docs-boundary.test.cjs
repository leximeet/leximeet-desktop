"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { checkDocs } = require("../../scripts/check-docs.cjs");

function fixture(t, body) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-public-docs-"));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const repo = path.join(workspace, "project");
  fs.mkdirSync(path.join(repo, "frontend"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs"));
  fs.writeFileSync(path.join(repo, "README.md"), body);
  fs.writeFileSync(path.join(repo, "frontend/README.md"), "# 开发\n");
  fs.writeFileSync(path.join(repo, "docs/使用.md"), "[首页](../README.md)\n");
  // 邻仓资料真实存在，避免只因文件缺失使负例侥幸通过。
  fs.writeFileSync(path.join(workspace, "邻仓.md"), "# 邻仓资料\n");
  return repo;
}

test("公开文档支持本仓上级链接与远程邻仓文档", (t) => {
  const repo = fixture(
    t,
    "[使用](docs/使用.md)\n[邻仓](https://github.com/leximeet/leximeet-browser)\n",
  );
  assert.doesNotThrow(() => checkDocs(repo));
});

test("即使本地邻仓存在，Markdown 跨仓相对链接仍被拒绝", (t) => {
  assert.throws(() => checkDocs(fixture(t, "[邻仓](../邻仓.md)\n")), /链接越出仓库/);
});

test("HTML 链接也不能依赖克隆目录以外的资料", (t) => {
  assert.throws(
    () => checkDocs(fixture(t, '<a href="../邻仓.md">邻仓</a>\n')),
    /HTML 链接越出仓库/,
  );
});
