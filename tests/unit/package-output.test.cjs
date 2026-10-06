"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  newPackageOutput,
  resolvePackageOutput,
  savePackagePointer,
} = require("../../scripts/lib/package-output.cjs");

test("新构建按版本、架构和时间隔离，明确目录优先", () => {
  const options = {
    version: "1.0.0",
    platform: "darwin",
    arch: "arm64",
    now: new Date("2026-10-04T00:00:00.000Z"),
    env: {},
  };
  const output = newPackageOutput("/project", options);
  assert.equal(output, "/project/release/1.0.0/darwin-arm64/20261004T000000000Z");
  assert.notEqual(
    output,
    newPackageOutput("/project", { ...options, now: new Date("2026-10-04T00:00:00.001Z") }),
  );
  assert.equal(
    newPackageOutput("/project", { ...options, env: { LEXIMEET_BUILD_OUTPUT: "custom" } }),
    "/project/custom",
  );
});

test("只有完整且版本相符的指针可用于默认验收，不从旧 release 猜测", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-package-pointer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => resolvePackageOutput(root, {}), /没有本轮完整构建/);
  const output = path.join(root, "release/1.0.0/current");
  fs.mkdirSync(output, { recursive: true });
  const write = (status, version = "1.0.0") =>
    fs.writeFileSync(
      path.join(output, "BUILD-MANIFEST.json"),
      JSON.stringify({ format: "leximeet.build/1", status, version }),
    );
  savePackagePointer(root, output, "1.0.0");
  write("failed");
  assert.throws(() => resolvePackageOutput(root, {}), /构建未完成/);
  write("complete", "0.0.1");
  assert.throws(() => resolvePackageOutput(root, {}), /版本不一致/);
  write("complete");
  assert.equal(resolvePackageOutput(root, {}), output);
  savePackagePointer(root, output, "1.0.0", "building");
  assert.throws(() => resolvePackageOutput(root, {}), /最近一次构建没有完成/);
  savePackagePointer(root, output, "1.0.0", "failed");
  assert.throws(() => resolvePackageOutput(root, {}), /不会选择更早的旧包/);
  assert.equal(
    resolvePackageOutput(root, { LEXIMEET_BUILD_OUTPUT: "explicit" }),
    path.join(root, "explicit"),
  );
});
