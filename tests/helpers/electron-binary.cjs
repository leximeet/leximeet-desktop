"use strict";
const fs = require("node:fs");

/** 各平台已安装的 Electron 可执行文件；供 Native Host / MCP 真实进程测试使用。 */
function electronBinary() {
  const resolved = require("electron");
  if (typeof resolved !== "string" || !fs.existsSync(resolved))
    throw new Error("需要已安装的 Electron 二进制");
  return resolved;
}

module.exports = { electronBinary };
