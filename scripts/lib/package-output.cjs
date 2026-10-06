"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 每次构建独占一个目录，DMG / ZIP / .app 不会和上次候选混在一起。
function newPackageOutput(root, { version, platform, arch, now = new Date(), env = process.env }) {
  if (env.LEXIMEET_BUILD_OUTPUT) return path.resolve(root, env.LEXIMEET_BUILD_OUTPUT);
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return path.join(root, "release", version, `${platform}-${arch}`, stamp);
}

// 默认验收只查最后一次完整构建；失败或旧目录不能被默默选中。
function resolvePackageOutput(root, env = process.env) {
  if (env.LEXIMEET_BUILD_OUTPUT) return path.resolve(root, env.LEXIMEET_BUILD_OUTPUT);
  const pointer = path.join(root, ".runtime/current-package.json");
  if (!fs.existsSync(pointer))
    throw new Error("没有本轮完整构建：请先运行 npm run package:dir 或 npm run package:dist");
  const current = JSON.parse(fs.readFileSync(pointer, "utf8"));
  if (current.format !== "leximeet.package-pointer/1" || typeof current.directory !== "string")
    throw new Error("构建指针格式不正确，请重新打包");
  if (current.status !== "complete")
    throw new Error(
      "最近一次构建没有完成，默认验收不会选择更早的旧包；请重新打包或显式指定候选目录",
    );
  const directory = path.resolve(root, current.directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "BUILD-MANIFEST.json"), "utf8"));
  if (
    manifest.format !== "leximeet.build/1" ||
    manifest.status !== "complete" ||
    manifest.version !== current.version
  )
    throw new Error("构建未完成或指针与物料版本不一致，请重新打包");
  return directory;
}

function savePackagePointer(root, directory, version, status = "complete") {
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".runtime/current-package.json"),
    JSON.stringify(
      {
        format: "leximeet.package-pointer/1",
        status,
        version,
        directory: path.relative(root, directory).split(path.sep).join("/"),
      },
      null,
      2,
    ) + "\n",
  );
}

module.exports = { newPackageOutput, resolvePackageOutput, savePackagePointer };
