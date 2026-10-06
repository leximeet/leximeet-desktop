const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findArtifact } = require("./artifacts.cjs");
const { createInstallation, assertInstaller } = require("./lib/installer.cjs");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "test-results/install");
fs.mkdirSync(output, { recursive: true });
let installation;
try {
  const installer = process.env.LEXIMEET_INSTALLER || findArtifact("installer");
  assertInstaller(installer);
  installation = createInstallation();
  const executable = installation.install(installer);
  const result = spawnSync(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      "--config",
      "playwright.desktop-package.config.cjs",
      ...process.argv.slice(2),
    ],
    {
      cwd: root,
      stdio: "inherit",
      env: { ...process.env, LEXIMEET_PACKAGED_EXECUTABLE: executable },
    },
  );
  if (result.error || result.status !== 0) throw result.error || new Error("安装后的应用验收失败");
  console.log("安装产物 → 隔离目标目录 → 真实应用启动/离线查词/重启持久化：通过");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (installation) {
    try {
      installation.cleanup();
    } catch (error) {
      console.error(`安装沙箱清理失败：${error.message}`);
      process.exitCode = 1;
    }
    fs.writeFileSync(
      path.join(output, "installer-log.json"),
      JSON.stringify(installation.events, null, 2) + "\n",
    );
  }
}
