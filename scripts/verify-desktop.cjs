"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { prepare } = require("./accept-desktop.cjs");
const root = path.resolve(__dirname, "..");

// 本机版本门禁只覆盖桌面内部链路；LMCP 使用真实 Host 与模拟浏览器；真实插件和云端联调分别验收。
async function verify() {
  require("../tests/helpers/background-environment.cjs").assertBackgroundRunner();
  console.log(
    "后台自动回归：隐藏窗口、静音、受控系统输入；macOS 额外检查完整生命周期的前台应用 PID。可见验收使用 npm run accept:desktop。",
  );
  await prepare();
  // 在测试外准备并校验固定 Full 分片，原生测试只读这份公共物料，不依赖相邻开发仓库或外部网络。
  process.env.LEXIMEET_DICTIONARY_TEST_SOURCE =
    await require("./prepare-dictionary.cjs").prepareSource("full-text");
  const npm = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  // Core 的 clean test 会删除运行 jar；测试通过后再打包，保证集成与 UI 使用刚测试的源码。
  for (const script of [
    "verify:lmcp:contract",
    "test:unit",
    "test:core",
    "build:core",
    "test:integration",
    "test:lmcp:transport",
    "test:desktop",
  ]) {
    console.log(`\n正在验证 ${script}…`);
    const result = spawnSync(npm, ["run", script], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
    });
    if (result.error || result.status !== 0) throw result.error || new Error(`${script} 未通过`);
  }
  console.log("桌面本机门禁通过；应用包与人工功能验收另见本地测试启动文档。");
}
if (require.main === module)
  verify().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { verify };
