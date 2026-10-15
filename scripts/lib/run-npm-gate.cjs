"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { dumpProcessTree } = require("./dump-process-tree.cjs");

const root = path.resolve(__dirname, "../..");

const DEFAULT_BUDGET_MS = Object.freeze({
  "verify:lmcp:contract": 60000,
  "verify:mcp:contract": 60000,
  "test:unit": 180000,
  "test:core": 360000,
  "build:core": 180000,
  "test:integration": 180000,
  "test:lmcp:transport": 420000,
  "test:mcp": 180000,
  "test:desktop": 900000,
});

function runNpmScripts(scripts, { budgets = DEFAULT_BUDGET_MS, cwd = root } = {}) {
  const npm = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  for (const script of scripts) {
    console.log(`\n正在验证 ${script}…`);
    const timeout = budgets[script] || 180000;
    const result = spawnSync(npm, ["run", script], {
      cwd,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout,
      killSignal: "SIGKILL",
    });
    if (result.error?.code === "ETIMEDOUT" || result.signal === "SIGKILL") {
      dumpProcessTree(`${script} 超过 ${timeout}ms 仍未退出`);
      throw new Error(`${script} 超时（${timeout}ms）；已打印进程树`);
    }
    if (result.error || result.status !== 0) throw result.error || new Error(`${script} 未通过`);
  }
}

module.exports = { runNpmScripts, DEFAULT_BUDGET_MS };
