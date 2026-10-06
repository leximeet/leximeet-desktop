"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const { extractFile } = require("@electron/asar");
const { verifyPackageMaterials, findResources } = require("../verify-package-materials.cjs");

async function digest(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

function sourceState(directory) {
  const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: directory,
    encoding: "utf8",
  });
  // 源码 tar 没有 .git 也应能重建；不借用上层其他仓库的 HEAD 冒充其来源。
  if (
    probe.error ||
    probe.status !== 0 ||
    path.resolve(probe.stdout.trim()) !== path.resolve(directory)
  )
    return { commit: null, dirty: null };
  const read = (...args) => {
    const result = spawnSync("git", args, { cwd: directory, encoding: "utf8" });
    if (result.error || result.status !== 0) throw new Error("无法记录实际源码状态");
    return result.stdout.trim();
  };
  return { commit: read("rev-parse", "HEAD"), dirty: Boolean(read("status", "--porcelain")) };
}

// 比对实际物料后才产生完整标记；清单中只写相对路径，不带构建者个人目录。
async function writeBuildManifest({ root, output, mode, version, sources }) {
  const resourcesDir = findResources(output);
  const materials = verifyPackageMaterials({ projectDir: root, resourcesDir });
  const packaged = JSON.parse(extractFile(path.join(resourcesDir, "app.asar"), "package.json"));
  if (packaged.version !== version) throw new Error("实际应用版本与本轮构建版本不一致");
  const files = fs
    .readdirSync(output)
    .filter((name) => /\.(?:dmg|zip|exe|AppImage)$/.test(name))
    .sort();
  if (mode === "dist" && !files.length) throw new Error("未生成本轮安装文件");
  const artifacts = [];
  for (const name of files)
    artifacts.push({
      file: name,
      bytes: fs.statSync(path.join(output, name)).size,
      sha256: await digest(path.join(output, name)),
    });
  const current = { desktop: sourceState(root), core: sourceState(path.join(root, "core-java")) };
  if (sources && JSON.stringify(current) !== JSON.stringify(sources))
    throw new Error("构建期间源码提交或干净状态发生变化，请重新构建同一候选");
  sources ||= current;
  const contract = JSON.parse(fs.readFileSync(path.join(root, "resources/lmcp/contract.json")));
  const dictionary = JSON.parse(
    fs.readFileSync(path.join(resourcesDir, "dictionary/release.json")),
  );
  const runtime = JSON.parse(
    fs.readFileSync(path.join(resourcesDir, "runtime/leximeet-runtime.json")),
  );
  const manifest = {
    format: "leximeet.build/1",
    status: "complete",
    version,
    createdAt: new Date().toISOString(),
    platform: process.platform,
    arch: process.arch,
    mode,
    sources,
    runtime,
    protocol: { version: contract.apiVersion, digest: contract.contractDigest },
    dictionary,
    coreJar: { sha256: await digest(path.join(resourcesDir, "core/leximeet-core.jar")) },
    application: {
      file: path.relative(output, path.join(resourcesDir, "app.asar")).split(path.sep).join("/"),
      sha256: await digest(path.join(resourcesDir, "app.asar")),
    },
    artifacts,
    verification: {
      materials: "passed",
      checkedFiles: materials.checkedFiles,
      applicationStartup: "not-run",
      upgrade: "not-run",
      systemPermissions: "manual",
    },
    distribution: {
      published: false,
      signing: process.platform === "darwin" ? "ad-hoc" : "unsigned",
      notarized: false,
    },
  };
  fs.writeFileSync(
    path.join(output, "BUILD-MANIFEST.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  fs.writeFileSync(
    path.join(output, "SHA256SUMS"),
    artifacts.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
  );
  return manifest;
}

module.exports = { writeBuildManifest, sourceState };
