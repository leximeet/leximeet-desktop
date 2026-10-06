"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { verifyReleaseVersions } = require("../../scripts/lib/release-versions.cjs");

// 模拟四份独立仓库，防止漏改 lockfile 或 Core 子模块后仍生成绿色报告。
test("四仓版本一致才允许开始联合验收", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-release-versions-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(
    ["desktop", "core", "browser", "protocol"].map((name) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      return [name, directory];
    }),
  );
  const writePackage = (name, version, lockVersion = version) => {
    fs.writeFileSync(path.join(paths[name], "package.json"), JSON.stringify({ version }));
    fs.writeFileSync(
      path.join(paths[name], "package-lock.json"),
      JSON.stringify({ version: lockVersion, packages: { "": { version: lockVersion } } }),
    );
  };
  for (const name of ["desktop", "browser", "protocol"]) writePackage(name, "0.0.1");
  fs.writeFileSync(
    path.join(paths.core, "pom.xml"),
    "<artifactId>leximeet-core</artifactId><version>0.0.1</version><dependencies><version>3.5.16</version></dependencies>",
  );
  assert.equal(verifyReleaseVersions(paths), "0.0.1");
  writePackage("browser", "0.0.1", "0.1.0");
  assert.throws(() => verifyReleaseVersions(paths), /Browser.*版本不一致/);
  writePackage("browser", "0.1.0");
  assert.throws(() => verifyReleaseVersions(paths), /四仓产品版本不一致/);
});
