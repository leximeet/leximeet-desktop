"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

/**
 * 只为 factory 自有资料创建业务时钟；系统时间与 LMCP 认证时间不改。
 * Core 自己仍校验 profile、目录归属、文件权限与内容，辅助工具不代替生产边界。
 */
function createBusinessClock(
  profileDir,
  { instant = "2026-10-05T02:00:00Z", zone = "Asia/Shanghai" } = {},
) {
  const coreDir = path.join(profileDir, "core");
  if (fs.existsSync(coreDir) && fs.lstatSync(coreDir).isSymbolicLink())
    throw new Error("业务时钟不能写入符号链接目录");
  fs.mkdirSync(coreDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(coreDir, 0o700);
  const file = path.join(coreDir, "test-clock.json");
  if (fs.existsSync(file)) throw new Error("业务时钟已经存在，不覆盖既有测试旅程");
  new Intl.DateTimeFormat("zh-CN", { timeZone: zone });
  let current;
  function advanceTo(value) {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) throw new Error("业务时钟需要有效 ISO 时间");
    if (current !== undefined && timestamp < current)
      throw new Error("日常旅程只能推进时间，不能倒退已经记录的学习");
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
      throw new Error("业务时钟文件不能是符号链接");
    const temporary = path.join(coreDir, `.test-clock-${randomUUID()}.json`);
    try {
      fs.writeFileSync(
        temporary,
        JSON.stringify({ instant: new Date(timestamp).toISOString(), zone }) + "\n",
        { mode: 0o600, flag: "wx" },
      );
      fs.renameSync(temporary, file);
      current = timestamp;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    return { instant: new Date(current).toISOString(), zone };
  }
  advanceTo(instant);
  return {
    file,
    environment: Object.freeze({ LEXIMEET_TEST_CLOCK_FILE: file }),
    snapshot: () => ({ instant: new Date(current).toISOString(), zone }),
    advanceTo,
    advanceDays(days = 1) {
      if (!Number.isInteger(days) || days < 0) throw new Error("业务日期只能增加非负整数天");
      return advanceTo(new Date(current + days * 86400000).toISOString());
    },
  };
}

module.exports = { createBusinessClock };
