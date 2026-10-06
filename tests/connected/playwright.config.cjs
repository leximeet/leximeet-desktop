"use strict";
const path = require("node:path");
const { defineConfig } = require("@playwright/test");
require("../helpers/background-environment.cjs").assertBackgroundRunner();
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
const output = path.resolve(process.env.LEXIMEET_TEST_OUTPUT || "test-results/connected-package");
module.exports = defineConfig({
  testDir: __dirname,
  testMatch: [
    "package-connected.spec.cjs",
    "capture-entry.spec.cjs",
    "capture-policy.spec.cjs",
    "reading-word-grouping.spec.cjs",
    "startup.spec.cjs",
  ],
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 300000,
  expect: { timeout: 20000 },
  outputDir: path.join(output, "artifacts"),
  reporter: [["list"], ["json", { outputFile: path.join(output, "results.json") }]],
  use: {
    headless: true,
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    trace: "retain-on-failure",
  },
});
