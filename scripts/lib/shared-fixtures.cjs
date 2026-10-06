"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { isDeepStrictEqual } = require("node:util");
const { createHash } = require("node:crypto");

// 消费者可以独立检出运行；工作区验收必须额外确认测试副本没有偏离协议真源。
function verifyFixtureCopies(source, consumers) {
  const verified = [];
  const read = (directory, name) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    } catch (error) {
      throw new Error(`无法读取共享样例 ${name}（${directory}）：${error.message}`);
    }
  };
  for (const { name, directory, fixtures } of consumers) {
    if (!fixtures.length) throw new Error(`${name} 必须声明共享样例`);
    for (const fixture of fixtures) {
      const expected = read(source, fixture);
      if (!isDeepStrictEqual(expected, read(directory, fixture)))
        throw new Error(`${name} 的 ${fixture} 与 LMCP 共享样例不一致；同步消费端回归后再验收`);
      // 记录真源语义摘要，不复制样例正文或测试凭据到工作区汇总。
      verified.push({
        consumer: name,
        fixture,
        sourceHash: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
      });
    }
  }
  return verified;
}
module.exports = { verifyFixtureCopies };
