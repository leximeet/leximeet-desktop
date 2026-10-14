"use strict";
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

/** Windows / Linux 的 core-cross 门禁：契约、单元、Core、传输与 MCP，不含七天旅程。 */
async function verify() {
  require("../tests/helpers/background-environment.cjs").assertBackgroundRunner();
  const npm = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  require("./build-run-as-node.cjs").build({ required: process.platform === "win32" });
  for (const script of [
    "verify:lmcp:contract",
    "verify:mcp:contract",
    "test:unit",
    "test:core",
    "build:core",
    "test:integration",
    "test:lmcp:transport",
    "test:mcp",
  ]) {
    console.log(`\n正在验证 ${script}…`);
    const result = spawnSync(npm, ["run", script], {
      cwd: root,
      env: process.env,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (result.error || result.status !== 0) throw result.error || new Error(`${script} 未通过`);
  }
  console.log("跨平台 core-cross 门禁通过；安装冒烟见干净 runner 上的 install-smoke。");
}

if (require.main === module)
  verify().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { verify };
