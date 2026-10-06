"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 测试仅推进学习业务时间。配对、授权、限流和网络期限继续用真实时钟。
function businessClock({ profile, file = "" }) {
  if (!file) return Date.now;
  if (
    profile.name !== "test" ||
    path.resolve(file) !== path.join(profile.coreDir, "test-clock.json")
  )
    throw new Error("业务测试时钟必须位于隔离 test 资料目录");
  const now = () => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024)
      throw new Error("无效的业务测试时钟文件");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    const instant = Date.parse(value.instant);
    if (!Number.isFinite(instant)) throw new Error("业务测试时钟缺少有效 instant");
    return instant;
  };
  now();
  return now;
}
module.exports = { businessClock };
