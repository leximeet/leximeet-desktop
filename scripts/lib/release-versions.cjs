"use strict";
const fs = require("node:fs");
const path = require("node:path");

// 发布单元以 Desktop 为基准；包元数据与锁文件必须描述同一个版本。
function packageVersion(directory, name) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  const lock = JSON.parse(fs.readFileSync(path.join(directory, "package-lock.json"), "utf8"));
  if (
    !manifest.version ||
    manifest.version !== lock.version ||
    manifest.version !== lock.packages?.[""]?.version
  )
    throw new Error(`${name} 的 package.json 与 package-lock.json 版本不一致`);
  return manifest.version;
}

// 只读取 Core 项目的版本，不把依赖版本或数据库 schema 误作产品版本。
function coreVersion(directory) {
  const pom = fs.readFileSync(path.join(directory, "pom.xml"), "utf8");
  const match = pom.match(/<artifactId>leximeet-core<\/artifactId>\s*<version>([^<]+)<\/version>/);
  if (!match) throw new Error("无法读取 Core 产品版本");
  return match[1];
}

function verifyReleaseVersions({ desktop, core, browser, protocol }) {
  const versions = {
    desktop: packageVersion(desktop, "Desktop"),
    core: coreVersion(core),
    browser: packageVersion(browser, "Browser"),
    protocol: packageVersion(protocol, "Protocol"),
  };
  if (new Set(Object.values(versions)).size !== 1)
    throw new Error(`四仓产品版本不一致：${JSON.stringify(versions)}`);
  return versions.desktop;
}

module.exports = { verifyReleaseVersions };
