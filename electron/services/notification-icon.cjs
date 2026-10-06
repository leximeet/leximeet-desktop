"use strict";
const path = require("node:path");
// 通知与窗口、Dock、安装包沿用同一透明符号。macOS 通知外壳由系统管理。
module.exports = { NOTIFICATION_ICON: path.resolve(__dirname, "../../resources/brand/icon.png") };
