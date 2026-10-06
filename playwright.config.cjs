const { defineConfig } = require("@playwright/test");
require("./tests/helpers/background-environment.cjs").assertBackgroundRunner();
const path = require("node:path");
const reportRoot = process.env.LEXIMEET_TEST_OUTPUT
  ? path.join(process.env.LEXIMEET_TEST_OUTPUT, "desktop")
  : ".";
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
const suite = process.env.LEXIMEET_TEST_SUITE || "all";

module.exports = defineConfig({
  // 浏览器和 Electron 均静默隔离；串行控制资源预算，跨 runner 可独立并行。
  fullyParallel: false,
  workers: 1,
  timeout: 90000,
  expect: {
    timeout: 15000,
  },
  forbidOnly: true,
  retries: 0,
  updateSnapshots: "none",
  outputDir: path.join(reportRoot, `test-results/${suite}`),
  reporter: [
    ["list"],
    ["html", { outputFolder: path.join(reportRoot, `playwright-report/${suite}`), open: "never" }],
    ["junit", { outputFile: path.join(reportRoot, `test-results/reports/${suite}.xml`) }],
    ["json", { outputFile: path.join(reportRoot, `test-results/reports/${suite}.json`) }],
  ],
  use: { actionTimeout: 15000 },
  projects: [
    { name: "upgrade", testDir: "./tests/electron", testMatch: "upgrade.spec.cjs" },
    { name: "install-upgrade", testDir: "./tests/electron", testMatch: "install-upgrade.spec.cjs" },
  ],
});
