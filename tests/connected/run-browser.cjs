#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { once } = require("node:events");
const gate = require("../../scripts/lib/connected-readiness.cjs");
const desktopRoot = path.resolve(__dirname, "../..");
const browserRoot = path.resolve(desktopRoot, "../plugin/leximeet-browser");
const REQUIRED_SCENARIOS = 9;
const SCENARIO_GROUPS = Object.freeze({ connectionAndCapture: 7, readingUi: 2 });

// 必须是当前九场全通过，且断言和生产字节没有变化；旧报告不能替代新采集场景。
function passesCurrentSuite(record, stats) {
  return (
    record.exitCode === 0 &&
    !record.interrupted &&
    record.testsUnchanged === true &&
    record.productionBytesUnchanged === true &&
    stats?.expected === REQUIRED_SCENARIOS &&
    stats.unexpected === 0 &&
    stats.skipped === 0 &&
    stats.flaky === 0
  );
}

// 运行 Browser 当前九场真实联调；记录整套入口断言与生产字节，不以旧三场代替采集回归。
async function main() {
  if (process.argv.length > 2)
    throw new Error("该入口不接受可见/调试/重试参数；人工验收使用 --connected");
  if (process.platform !== "darwin") throw new Error("真实 Native 联调当前仅完成 macOS");
  require("../helpers/background-environment.cjs").assertBackgroundRunner();
  const candidate = gate.checkReadiness();
  require("../../scripts/lmcp/verify-contract.cjs").verifyContract();
  const outputDir = path.resolve(
    process.env.LEXIMEET_TEST_OUTPUT ||
      path.join(desktopRoot, "test-results/connected-real-browser"),
  );
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(outputDir, 0o700);
  const log = fs.openSync(path.join(outputDir, "browser-connected.log"), "w", 0o600);
  const fingerprint = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const head = (cwd) => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(result.stdout.trim()))
      throw new Error("无法核对当前源码提交");
    return result.stdout.trim();
  };
  const suiteFiles = [
    "playwright.connected.config.ts",
    ...[
      "connector.spec.ts",
      "capture-entry.spec.ts",
      "helpers.ts",
      "capture-scenarios.mjs",
      "connection-ui.mjs",
      "connection-ui.d.mts",
      "capture-scenarios.d.mts",
      "reading-ui.spec.ts",
    ].map((name) => `tests/connected/${name}`),
  ];
  const suiteHashes = () =>
    Object.fromEntries(suiteFiles.map((name) => [name, fingerprint(path.join(browserRoot, name))]));
  const record = {
    format: "leximeet.connected-current-suite/2",
    startedAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    browserCommit: head(browserRoot),
    desktopCommit: head(desktopRoot),
    contractVersion: gate.CONTRACT_VERSION,
    contractDigest: gate.CONTRACT_DIGEST,
    testFiles: suiteFiles,
    testHashes: suiteHashes(),
    requiredScenarios: REQUIRED_SCENARIOS,
    scenarioGroups: SCENARIO_GROUPS,
    productionHashes: candidate.productionHashes,
    passed: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(outputDir, "current-suite.json"),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    );
  save();
  const child = spawn(
    process.execPath,
    [
      require.resolve("@playwright/test/cli", { paths: [browserRoot] }),
      "test",
      "--config",
      "playwright.connected.config.ts",
    ],
    {
      cwd: browserRoot,
      detached: true,
      env: { ...process.env, LEXIMEET_TEST_OUTPUT: outputDir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let forceTimer, interrupted;
  const signal = (name) => {
    interrupted = name;
    if (!Number.isInteger(child.pid) || child.exitCode !== null || child.signalCode !== null)
      return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    forceTimer ||= setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if (error.code !== "ESRCH") console.error(error.message);
        }
    }, 10000);
  };
  const onInt = () => signal("SIGINT"),
    onTerm = () => signal("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => {
      fs.writeSync(log, bytes);
      process.stdout.write(bytes);
    });
  try {
    // 等 stdout/stderr 一并关闭，避免 exit 后最后一段报告写进已关闭的日志句柄。
    const [code, childSignal] = await once(child, "close");
    record.exitCode = code;
    record.signal = childSignal;
    record.interrupted = interrupted || null;
    record.testsUnchanged = JSON.stringify(suiteHashes()) === JSON.stringify(record.testHashes);
    record.productionBytesUnchanged =
      JSON.stringify(gate.treeHashes(candidate.extensionDir)) ===
      JSON.stringify(candidate.productionHashes);
    const result = JSON.parse(
      fs.readFileSync(path.join(outputDir, "connected/results.json"), "utf8"),
    );
    record.stats = result.stats;
    record.passed = passesCurrentSuite(record, result.stats);
    if (!record.passed)
      throw new Error("Browser 当前九场联调未全部通过，或生产字节/断言改变；请查看本轮报告");
  } finally {
    clearTimeout(forceTimer);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    fs.closeSync(log);
    record.stoppedAt = new Date().toISOString();
    save();
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { main, passesCurrentSuite, REQUIRED_SCENARIOS, SCENARIO_GROUPS };
