"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { resolvePackageOutput } = require("./lib/package-output.cjs");

// 安装/升级真实测试成功后由调用方记录；不会把 build 当成 UI 验收。
function recordPackageCheck(directory, stage, status) {
  if (!["install", "upgrade"].includes(stage) || !["passed", "failed"].includes(status))
    throw new Error("检查记录只接受 install / upgrade 与 passed / failed");
  const file = path.join(directory, "BUILD-MANIFEST.json");
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  if (manifest.format !== "leximeet.build/1" || manifest.status !== "complete")
    throw new Error("不能记录未完成的构建");
  manifest.verification[stage === "install" ? "applicationStartup" : "upgrade"] =
    stage === "install" && status === "passed" ? "installed-application-passed" : status;
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}
if (require.main === module) {
  try {
    const root = path.resolve(__dirname, "..");
    recordPackageCheck(
      process.argv[4] ? path.resolve(process.argv[4]) : resolvePackageOutput(root),
      process.argv[2],
      process.argv[3],
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { recordPackageCheck };
