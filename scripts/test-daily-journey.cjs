"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");
const { assertBackgroundRunner } = require("../tests/helpers/background-environment.cjs");

const root = path.resolve(__dirname, "..");
const files = [
  "initialization.spec.cjs",
  "practice-regression.spec.cjs",
  "seven-days.spec.cjs",
  "visual-regression.spec.cjs",
];
const hash = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

// 每一条验收 lane 都记录实际用到的辅助代码；故障夹具变化不能沿用旧通过证据。
function testHashesFor(suite) {
  const testFiles = [
    ...suite.map((file) => `tests/daily-journey/${file}`),
    "tests/daily-journey/playwright.config.cjs",
    "tests/helpers/business-clock.cjs",
    "tests/helpers/practice-ack-loss.cjs",
    "tests/helpers/hint-read-loss.cjs",
    "tests/helpers/practice-save-loss.cjs",
    "tests/helpers/clipboard-ack-loss.cjs",
    "tests/helpers/journey-evidence.cjs",
    "tests/helpers/electron-fixture.cjs",
  ];
  return Object.fromEntries(testFiles.map((file) => [file, hash(path.join(root, file))]));
}

function options(args) {
  const result = { mode: "source", prepared: false, check: false };
  let selectedMode;
  function mode(value) {
    if (selectedMode) throw new Error("一次验收只能选择一种 Source、包或升级模式");
    selectedMode = value;
    result.mode = value;
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--prepared") result.prepared = true;
    else if (arg === "--check") result.check = true;
    else if (arg === "--source") mode("source");
    else if (arg === "--package") {
      mode("package");
      result.to = args[++i];
    } else if (arg === "--upgrade") {
      mode("upgrade");
      result.from = args[++i];
      result.to = args[++i];
    } else
      throw new Error(
        `不支持的参数 ${arg}；使用 --source / --package 新应用路径 / --upgrade 旧应用路径 新应用路径，以及可选 --prepared`,
      );
  }
  if (result.mode !== "source") {
    for (const name of result.mode === "upgrade" ? ["from", "to"] : ["to"])
      if (!result[name] || !path.isAbsolute(result[name]) || !fs.statSync(result[name]).isFile())
        throw new Error("应用路径必须是已存在的绝对可执行文件路径；不会用源码替代缺失的应用包");
    if (result.mode === "upgrade" && fs.realpathSync(result.from) === fs.realpathSync(result.to))
      throw new Error("升级需要两个不同的真实应用包");
  }
  return result;
}

async function main() {
  assertBackgroundRunner();
  const choice = options(process.argv.slice(2));
  if (choice.check) {
    // 只读检查不下载环境，也不加载 Electron 或注册 Native Host。
    for (const file of [
      "node_modules/@playwright/test/cli.js",
      "core-java/target/leximeet-core.jar",
      "frontend/dist/index.html",
    ])
      if (!fs.existsSync(path.join(root, file)))
        throw new Error(`缺少 ${file}；正常启动会自动准备当前构建`);
    console.log("日常验收入口检查通过，未启动窗口、改资料或下载工具。");
    return;
  }
  if (!choice.prepared) await require("./accept-desktop.cjs").prepare();
  const output = path.resolve(
    process.env.LEXIMEET_JOURNEY_OUTPUT ||
      path.join(root, "test-results/daily-journey", `${choice.mode}-${crypto.randomUUID()}`),
  );
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const suite = choice.mode === "upgrade" ? ["upgrade.spec.cjs"] : files;
  const testHashes = testHashesFor(suite);
  const testFiles = Object.keys(testHashes);
  const record = {
    format: "leximeet.daily-journey/1",
    startedAt: new Date().toISOString(),
    mode: choice.mode,
    preparedCurrentSource: !choice.prepared,
    actualFrom: choice.from || null,
    actualTo: choice.to || null,
    testHashes,
    expectedCases: choice.mode === "upgrade" ? 1 : 7,
    passed: false,
  };
  const save = () =>
    fs.writeFileSync(
      path.join(output, "current-suite.json"),
      JSON.stringify(record, null, 2) + "\n",
      { mode: 0o600 },
    );
  save();
  const env = { ...process.env, LEXIMEET_JOURNEY_OUTPUT: output };
  delete env.LEXIMEET_JOURNEY_VISUAL_BEFORE;
  delete env.LEXIMEET_JOURNEY_UPGRADE_FROM;
  delete env.LEXIMEET_JOURNEY_EXECUTABLE;
  if (choice.to) env.LEXIMEET_JOURNEY_EXECUTABLE = choice.to;
  if (choice.from) env.LEXIMEET_JOURNEY_UPGRADE_FROM = choice.from;
  const child = spawn(
    process.execPath,
    [
      require.resolve("@playwright/test/cli", { paths: [root] }),
      "test",
      "--config",
      "tests/daily-journey/playwright.config.cjs",
      ...suite,
    ],
    { cwd: root, env, stdio: "inherit" },
  );
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  record.exit = result;
  record.finishedAt = new Date().toISOString();
  record.testsUnchanged = testFiles.every(
    (file) => hash(path.join(root, file)) === testHashes[file],
  );
  try {
    const report = JSON.parse(fs.readFileSync(path.join(output, "results.json")));
    record.stats = report.stats;
    record.passed =
      result.code === 0 &&
      record.testsUnchanged &&
      report.stats.expected === record.expectedCases &&
      report.stats.unexpected === 0 &&
      report.stats.skipped === 0 &&
      report.stats.flaky === 0;
  } finally {
    save();
  }
  if (!record.passed) throw new Error(`日常验收未通过，保留原始结果：${output}`);
  console.log(`日常验收 ${record.expectedCases}/${record.expectedCases} 通过；报告：${output}`);
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { options, testHashesFor };
