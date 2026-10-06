"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Chrome 的 Native 子进程不能依赖桌面目录的 TCC 授权；只使用用户临时区的专属根。
function connectedSessionRoot() {
  return path.join(fs.realpathSync(os.tmpdir()), "leximeet-connected-sessions");
}
module.exports = { connectedSessionRoot };
