"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { options, testHashesFor } = require("../../scripts/test-daily-journey.cjs");

test("日常验收摘要包含真实确认草稿故障辅助代码，读取清单不会启动应用或构建", () => {
  const hashes = testHashesFor(["practice-regression.spec.cjs"]);
  const file = "tests/helpers/practice-save-loss.cjs";
  const actual = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.resolve(__dirname, "../..", file)))
    .digest("hex");
  assert.equal(hashes[file], actual);
  assert.ok(hashes["tests/daily-journey/practice-regression.spec.cjs"]);
  assert.ok(hashes["tests/helpers/hint-read-loss.cjs"]);
  assert.ok(hashes["tests/helpers/clipboard-ack-loss.cjs"]);
});

test("验收入口显式固定模式，检查或 prepared 参数不隐式构建和降级", () => {
  assert.deepEqual(options(["--prepared", "--check"]), {
    mode: "source",
    prepared: true,
    check: true,
  });
  assert.throws(() => options(["--source", "--package", "/missing"]), /一种/);
  assert.throws(() => options(["--unknown"]), /不支持/);
  assert.throws(() => options(["--package"]), /应用路径/);
});

test("升级入口拒绝同一可执行文件及其软链冒充第二版本，接受两条真实路径", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-journey-runner-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = path.join(dir, "old-app"),
    second = path.join(dir, "new-app"),
    alias = path.join(dir, "same-app");
  fs.writeFileSync(first, "old");
  fs.writeFileSync(second, "new");
  fs.symlinkSync(first, alias);
  assert.throws(() => options(["--upgrade", first, alias]), /不同/);
  assert.deepEqual(options(["--prepared", "--upgrade", first, second]), {
    mode: "upgrade",
    prepared: true,
    check: false,
    from: first,
    to: second,
  });
});
