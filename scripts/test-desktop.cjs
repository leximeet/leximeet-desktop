const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { assertInstaller } = require("./lib/installer.cjs");
const { findArtifact } = require("./artifacts.cjs");
const root = path.resolve(__dirname, "..");

async function main() {
  const suite = process.argv[2];
  const project = {
    upgrade: "upgrade",
    "install-upgrade": "install-upgrade",
  }[suite];
  if (!project) throw new Error("未知桌面测试套件");
  const env = { ...process.env, LEXIMEET_TEST_SUITE: suite };
  if (suite === "upgrade") {
    env.LEXIMEET_PACKAGED_EXECUTABLE ||= findArtifact("executable");
    if (
      !path.isAbsolute(env.LEXIMEET_PACKAGED_EXECUTABLE) ||
      !fs.existsSync(env.LEXIMEET_PACKAGED_EXECUTABLE)
    )
      throw new Error("LEXIMEET_PACKAGED_EXECUTABLE 必须是存在的绝对路径");
  }
  if (suite === "upgrade") {
    if (
      !env.LEXIMEET_UPGRADE_FROM ||
      !path.isAbsolute(env.LEXIMEET_UPGRADE_FROM) ||
      !fs.existsSync(env.LEXIMEET_UPGRADE_FROM)
    )
      throw new Error(
        "升级测试需要 LEXIMEET_UPGRADE_FROM 指向可信旧版本可执行文件；缺少旧包不能算验证通过",
      );
    if (
      fs.realpathSync(env.LEXIMEET_UPGRADE_FROM) ===
      fs.realpathSync(env.LEXIMEET_PACKAGED_EXECUTABLE)
    )
      throw new Error("升级前后不能使用同一个可执行文件");
  }
  if (suite === "install-upgrade") {
    env.LEXIMEET_INSTALLER ||= findArtifact("installer");
    if (!env.LEXIMEET_PREVIOUS_INSTALLER)
      throw new Error("需要 LEXIMEET_PREVIOUS_INSTALLER 指向可信旧安装产物");
    assertInstaller(env.LEXIMEET_PREVIOUS_INSTALLER);
    assertInstaller(env.LEXIMEET_INSTALLER);
  }
  process.exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        require.resolve("@playwright/test/cli"),
        "test",
        // 项目名显式绑定，文件过滤器不能被误识别成另一个 project。
        `--project=${project}`,
        ...process.argv.slice(3),
      ],
      { cwd: root, env, stdio: "inherit", windowsHide: true },
    );
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
