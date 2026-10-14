"use strict";
const { runNpmScripts } = require("./lib/run-npm-gate.cjs");

/** Windows / Linux 的 core-cross 门禁：契约、单元、Core、传输与 MCP，不含七天旅程。 */
async function verify() {
  require("../tests/helpers/background-environment.cjs").assertBackgroundRunner();
  require("./build-run-as-node.cjs").build({ required: process.platform === "win32" });
  console.log("正在准备随包 Core 词典…");
  await require("./prepare-dictionary.cjs").prepare({ edition: "core-text" });
  runNpmScripts([
    "verify:lmcp:contract",
    "verify:mcp:contract",
    "test:unit",
    "test:core",
    "build:core",
    "test:integration",
    "test:lmcp:transport",
    "test:mcp",
  ]);
  console.log("跨平台 core-cross 门禁通过；安装冒烟见干净 runner 上的 install-smoke。");
}

if (require.main === module)
  verify().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { verify };
