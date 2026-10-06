const { defineConfig } = require("@playwright/test");
require("./tests/helpers/background-environment.cjs").assertBackgroundRunner();
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
module.exports = defineConfig({
  testDir: "./tests/desktop001",
  fullyParallel: false,
  workers: 1,
  timeout: 180000,
  expect: { timeout: 20000 },
  forbidOnly: true,
  retries: 0,
  outputDir: "test-results/desktop-001/native",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/desktop-001", open: "never" }],
    ["json", { outputFile: "test-results/desktop-001/native-report.json" }],
  ],
  use: { actionTimeout: 15000 },
});
