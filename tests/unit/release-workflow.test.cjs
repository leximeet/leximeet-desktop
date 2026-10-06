"use strict";

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const assert = require("node:assert/strict");

// 执行工作流实际的前置检查，验证外部标签/发行状态变化不会绕过源码冻结与覆盖保护。
const workflow = fs.readFileSync(
  path.join(__dirname, "../../.github/workflows/candidate.yml"),
  "utf8",
);
const script = /^\s+node - <<'NODE'\n([\s\S]+?)^\s+NODE$/m.exec(workflow)[1];
const mainCommit = "a".repeat(40);
const taggedCommit = "b".repeat(40);

async function preflight({
  env = {},
  refType = "tag",
  targetType = "commit",
  releaseStatus = 404,
} = {}) {
  const output = [];
  const errors = [];
  const requests = [];
  const process = {
    env: {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_REF: "refs/heads/main",
      GITHUB_REF_NAME: "main",
      GITHUB_SHA: mainCommit,
      GITHUB_API_URL: "https://api.github.com",
      GITHUB_REPOSITORY: "leximeet/leximeet-desktop",
      GITHUB_OUTPUT: "test-output",
      DEFAULT_BRANCH: "main",
      REQUESTED_RELEASE_TAG: "1.0.0",
      ...env,
    },
    exitCode: 0,
  };
  await vm.runInNewContext(script, {
    process,
    console: { error: (message) => errors.push(message) },
    require: (name) => {
      assert.equal(name, "node:fs");
      return { appendFileSync: (_file, value) => output.push(value) };
    },
    fetch: async (url) => {
      requests.push(url);
      const status = url.includes("/releases/") ? releaseStatus : 200;
      return {
        status,
        ok: status >= 200 && status < 300,
        json: async () => ({
          object: url.includes("/git/ref/")
            ? { type: refType, sha: "c".repeat(40) }
            : { type: targetType, sha: taggedCommit },
        }),
      };
    },
  });
  return { code: process.exitCode, output: output.join(""), errors, requests };
}

test("恢复未发行标签：完整检查、打包与源码归档固定到原注解标签提交", async () => {
  const result = await preflight();
  assert.equal(result.code, 0);
  assert.equal(result.output, `source_ref=${taggedCommit}\nrelease_tag=1.0.0\n`);
  assert.equal(result.requests.length, 3);
});

test("正常标签推送采用相同冻结和保护检查", async () => {
  const result = await preflight({
    env: {
      GITHUB_EVENT_NAME: "push",
      GITHUB_REF: "refs/tags/1.0.0",
      GITHUB_REF_NAME: "1.0.0",
      REQUESTED_RELEASE_TAG: "",
    },
  });
  assert.equal(result.code, 0);
  assert.equal(result.output, `source_ref=${taggedCommit}\nrelease_tag=1.0.0\n`);
});

test("普通人工候选仅检查当前源码，不触发正式发行", async () => {
  const result = await preflight({ env: { REQUESTED_RELEASE_TAG: "" } });
  assert.equal(result.code, 0);
  assert.equal(result.output, `source_ref=${mainCommit}\nrelease_tag=\n`);
  assert.equal(result.requests.length, 0);
});

for (const releaseStatus of [200, 403, 500]) {
  test(`已有发行或无法确认（HTTP ${releaseStatus}）拒绝覆盖`, async () => {
    const result = await preflight({ releaseStatus });
    assert.equal(result.code, 1);
    assert.equal(result.output, "");
    assert.match(result.errors[0], /拒绝覆盖/);
  });
}

for (const [label, options] of [
  ["轻量标签", { refType: "commit" }],
  ["嵌套标签", { targetType: "tag" }],
  ["其他分支", { env: { GITHUB_REF: "refs/heads/other" } }],
  ["非正式版本", { env: { REQUESTED_RELEASE_TAG: "1.0.0-rc.1" } }],
  ["候选版本覆盖", { env: { REQUESTED_VERSION: "1.0.1" } }],
]) {
  test(`${label}不能冒充正式发行源码`, async () => {
    const result = await preflight(options);
    assert.equal(result.code, 1);
    assert.equal(result.output, "");
  });
}
