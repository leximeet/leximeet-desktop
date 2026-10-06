const { defineConfig } = require("@playwright/test");
require("./tests/helpers/background-environment.cjs").assertBackgroundRunner();
process.env.PW_CHROMIUM_ATTACH_TO_OTHER = "1";
module.exports = defineConfig({
  testDir: "./tests/desktop-package",
  workers: 1,
  timeout: 180000,
  retries: 0,
  forbidOnly: true,
  expect: { timeout: 20000 },
  outputDir: "test-results/desktop-001/package",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report/desktop-001-package", open: "never" }],
    ["json", { outputFile: "test-results/desktop-001/package-report.json" }],
  ],
  use: { actionTimeout: 15000 },
});
