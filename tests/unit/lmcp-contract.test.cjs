"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { verifyContract } = require("../../scripts/lmcp/verify-contract.cjs");
const source = path.resolve(__dirname, "../../resources/lmcp");
function copy(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-contract-"));
  fs.cpSync(source, directory, { recursive: true });
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}
test("1.0.0 固定身份和全部规范物料一致", () => {
  assert.deepEqual(verifyContract(source), {
    version: "1.0.0",
    digest: "61a44cc2f7f73fef81b007c844e1f2fa4deb955bf21a69236ee7b4f713808c49",
    files: 17,
  });
});
test("规范正文篡改、缺失或契约自改摘要都不能作为固定候选运行", (t) => {
  const directory = copy(t);
  const api = path.join(directory, "schemas/desktop-api.v1.schema.json");
  fs.appendFileSync(api, " ");
  assert.throws(() => verifyContract(directory), /规范物料改变/);
  fs.unlinkSync(api);
  assert.throws(() => verifyContract(directory), /ENOENT/);
  fs.copyFileSync(path.join(source, "schemas/desktop-api.v1.schema.json"), api);
  const contract = JSON.parse(fs.readFileSync(path.join(directory, "contract.json")));
  contract.contractDigest = "0".repeat(64);
  fs.writeFileSync(path.join(directory, "contract.json"), JSON.stringify(contract));
  assert.throws(() => verifyContract(directory), /固定的 1\.0\.0 快照/);
});
test("引用目录外的同内容物料也拒绝，不能借符号链接动态消费相邻仓库", (t) => {
  const directory = copy(t);
  const name = "methods.json",
    file = path.join(directory, name);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(source, name), file);
  assert.throws(() => verifyContract(directory), /越出固定目录/);
});
