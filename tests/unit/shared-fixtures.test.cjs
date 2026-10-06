"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyFixtureCopies } = require("../../scripts/lib/shared-fixtures.cjs");

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-fixtures-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "protocol"),
    copy = path.join(root, "browser");
  fs.mkdirSync(source);
  fs.mkdirSync(copy);
  const value = { scope: ["index:read"], emptyMeansNone: true };
  for (const dir of [source, copy])
    fs.writeFileSync(path.join(dir, "rules.json"), JSON.stringify(value));
  return {
    source,
    copy,
    consumers: [{ name: "browser", directory: copy, fixtures: ["rules.json"] }],
  };
}
test("共享样例按 JSON 语义比较，格式变化不误报", (t) => {
  const { source, copy, consumers } = sandbox(t);
  fs.writeFileSync(
    path.join(copy, "rules.json"),
    '{ "emptyMeansNone": true, "scope": ["index:read"] }',
  );
  const result = verifyFixtureCopies(source, consumers);
  assert.equal(result.length, 1);
  assert.match(result[0].sourceHash, /^[a-f0-9]{64}$/);
  assert.equal(Object.hasOwn(result[0], "scope"), false);
});
test("消费端自己的旧期望即使能通过单测，也不能通过工作区样例检查", (t) => {
  const { source, copy, consumers } = sandbox(t);
  fs.writeFileSync(path.join(copy, "rules.json"), '{"scope":[],"emptyMeansNone":true}');
  assert.throws(() => verifyFixtureCopies(source, consumers), /browser.*rules.json.*不一致/);
});
test("缺少共享真源、复制样例或无效 JSON 必须失败", (t) => {
  const { source, copy, consumers } = sandbox(t);
  const file = path.join(copy, "rules.json");
  fs.unlinkSync(file);
  assert.throws(() => verifyFixtureCopies(source, consumers), /无法读取共享样例/);
  fs.writeFileSync(file, "invalid");
  assert.throws(() => verifyFixtureCopies(source, consumers), /无法读取共享样例/);
  fs.unlinkSync(path.join(source, "rules.json"));
  assert.throws(() => verifyFixtureCopies(source, consumers), /无法读取共享样例/);
});
test("空的消费清单不能冒充已同步共享样例", (t) => {
  const { source, consumers } = sandbox(t);
  consumers[0].fixtures = [];
  assert.throws(() => verifyFixtureCopies(source, consumers), /必须声明共享样例/);
});
