"use strict";
const path = require("node:path");
const { defineConfig } = require("@playwright/test");
require("../helpers/background-environment.cjs").assertBackgroundRunner();
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
const output =
  process.env.LEXIMEET_JOURNEY_OUTPUT ||
  path.resolve(__dirname, "../../test-results/daily-journey");
module.exports = defineConfig({
  testDir: __dirname,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  forbidOnly: true,
  timeout: 240000,
  expect: { timeout: 20000 },
  outputDir: path.join(output, "artifacts"),
  reporter: [["list"], ["json", { outputFile: path.join(output, "results.json") }]],
  use: { actionTimeout: 15000 },
});
