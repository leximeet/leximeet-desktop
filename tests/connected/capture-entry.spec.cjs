"use strict";
const { test, expect } = require("@playwright/test");
const {
  registerCaptureScenarios,
} = require("../../../plugin/leximeet-browser/tests/connected/capture-scenarios.mjs");
// 与真实 Source 的三个入口共享断言，但驱动必须使用 isPackaged + 随包 JRE/Host。
registerCaptureScenarios(test, expect, require("./packaged-helpers.cjs"));
