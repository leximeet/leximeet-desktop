"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { resolvePackageOutput } = require("./lib/package-output.cjs");

const root = path.resolve(__dirname, "..");
const read = (directory, file) => JSON.parse(fs.readFileSync(path.join(directory, file), "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

/** 发布仅接受经过真实安装验证、源码与版本均吻合的 macOS arm64 载荷。 */
function validateCandidate({ tag, commit, coreCommit, metadata, manifest, source }) {
  if (
    !/^\d+\.\d+\.\d+$/.test(tag) ||
    metadata.version !== tag ||
    manifest.version !== tag ||
    source.version !== tag
  )
    throw new Error("正式标签与安装包版本不一致");
  if (
    metadata.commit !== commit ||
    manifest.sources?.desktop?.commit !== commit ||
    manifest.sources?.core?.commit !== coreCommit ||
    manifest.sources?.desktop?.dirty !== false ||
    manifest.sources?.core?.dirty !== false
  )
    throw new Error("安装包不是本标签对应的干净 Desktop/Core 源码");
  if (
    metadata.platform !== "darwin" ||
    metadata.arch !== "arm64" ||
    manifest.platform !== "darwin" ||
    manifest.arch !== "arm64" ||
    manifest.status !== "complete" ||
    manifest.mode !== "dist" ||
    manifest.verification?.materials !== "passed" ||
    manifest.verification?.applicationStartup !== "installed-application-passed"
  )
    throw new Error("仅发布已完成真实安装验收的 macOS arm64 安装包");
  if (source.sources?.length !== 2) throw new Error("发行源码必须同时且仅包含 Desktop 和 Core");
  for (const [repository, expected] of [
    ["leximeet-desktop", commit],
    ["leximeet-desktop-core", coreCommit],
  ]) {
    const item = source.sources?.find((value) => value.repository === repository);
    if (
      !item ||
      item.commit !== expected ||
      item.file !== `${repository === "leximeet-desktop" ? "desktop" : "core"}-source.tar.gz` ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("完整对应源码来源不一致");
  }
  const expectedFiles = [`LexiMeet-${tag}-mac-arm64.dmg`, `LexiMeet-${tag}-mac-arm64.zip`];
  if (
    manifest.artifacts?.length !== 2 ||
    !expectedFiles.every((name) =>
      manifest.artifacts.some((item) => item.file === name && /^[a-f0-9]{64}$/.test(item.sha256)),
    )
  )
    throw new Error("缺少同版本 DMG/ZIP 或其校验信息");
}

// 安装包可能较大，使用流式摘要，避免把整包读进发布进程内存。
async function identity(directory, file) {
  if (path.basename(file) !== file) throw new Error("附件必须使用直接文件名");
  const location = path.join(directory, file);
  const stat = fs.lstatSync(location);
  if (!stat.isFile()) throw new Error(`附件不是普通文件：${file}`);
  const hash = crypto.createHash("sha256");
  for await (const bytes of fs.createReadStream(location)) hash.update(bytes);
  return { file, bytes: stat.size, sha256: hash.digest("hex") };
}

async function verifyFiles(directory, files) {
  for (const item of files) {
    const actual = await identity(directory, item.file);
    if (actual.sha256 !== item.sha256 || (item.bytes !== undefined && actual.bytes !== item.bytes))
      throw new Error(`附件大小或 SHA-256 不符：${item.file}`);
  }
}

async function prepare(output, tag = process.env.GITHUB_REF_NAME) {
  const commit = git("rev-parse", "HEAD");
  const coreCommit = git("rev-parse", "HEAD:core-java");
  const packageOutput = resolvePackageOutput(root);
  const archives = path.join(root, "candidate-output");
  const metadata = read(archives, "metadata.json");
  const source = read(archives, "SOURCE_METADATA.json");
  const manifest = read(packageOutput, "BUILD-MANIFEST.json");
  validateCandidate({ tag, commit, coreCommit, metadata, source, manifest });
  if (git("status", "--porcelain") || read(root, "package.json").version !== tag)
    throw new Error("发布要求已提交且版本一致的源码");
  await verifyFiles(packageOutput, manifest.artifacts);
  await verifyFiles(archives, source.sources);
  // 新目录保存原样通过检查的附件，不重新构建，也不复制解压的 .app。
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  for (const item of manifest.artifacts)
    fs.copyFileSync(path.join(packageOutput, item.file), path.join(output, item.file));
  for (const item of source.sources)
    fs.copyFileSync(path.join(archives, item.file), path.join(output, item.file));
  fs.copyFileSync(
    path.join(archives, "SOURCE_METADATA.json"),
    path.join(output, "SOURCE_METADATA.json"),
  );
  fs.copyFileSync(
    path.join(packageOutput, "BUILD-MANIFEST.json"),
    path.join(output, "BUILD-MANIFEST.json"),
  );
  fs.copyFileSync(path.join(root, "LICENSE"), path.join(output, "LICENSE"));
  const files = await Promise.all(
    fs
      .readdirSync(output)
      .sort()
      .map((file) => identity(output, file)),
  );
  const release = {
    format: "leximeet.desktop-release/1",
    version: tag,
    releaseTag: tag,
    commit,
    coreCommit,
    platform: "darwin",
    arch: "arm64",
    signing: manifest.distribution.signing,
    notarized: manifest.distribution.notarized,
    verification: manifest.verification,
    files,
  };
  fs.writeFileSync(
    path.join(output, "RELEASE-MANIFEST.json"),
    JSON.stringify(release, null, 2) + "\n",
  );
  const checksummed = [...files, await identity(output, "RELEASE-MANIFEST.json")];
  fs.writeFileSync(
    path.join(output, "SHA256SUMS"),
    checksummed.map((item) => `${item.sha256}  ${item.file}\n`).join(""),
  );
  return release;
}

async function verify(output, tag = process.env.GITHUB_REF_NAME) {
  const release = read(output, "RELEASE-MANIFEST.json");
  if (
    release.format !== "leximeet.desktop-release/1" ||
    release.releaseTag !== tag ||
    release.version !== tag ||
    release.commit !== git("rev-parse", "HEAD") ||
    release.coreCommit !== git("rev-parse", "HEAD:core-java")
  )
    throw new Error("发行物与当前 Git 标签源码不一致");
  const expected = [
    `LexiMeet-${tag}-mac-arm64.dmg`,
    `LexiMeet-${tag}-mac-arm64.zip`,
    "desktop-source.tar.gz",
    "core-source.tar.gz",
    "SOURCE_METADATA.json",
    "BUILD-MANIFEST.json",
    "LICENSE",
  ].sort();
  if (JSON.stringify(release.files?.map((item) => item.file).sort()) !== JSON.stringify(expected))
    throw new Error("正式发行附件缺失或包含非预期文件");
  const manifest = read(output, "BUILD-MANIFEST.json");
  const source = read(output, "SOURCE_METADATA.json");
  validateCandidate({
    tag,
    commit: release.commit,
    coreCommit: release.coreCommit,
    metadata: release,
    source,
    manifest,
  });
  await verifyFiles(output, release.files);
  await verifyFiles(output, manifest.artifacts);
  await verifyFiles(output, source.sources);
  const files = [...release.files, await identity(output, "RELEASE-MANIFEST.json")];
  if (
    fs.readFileSync(path.join(output, "SHA256SUMS"), "utf8") !==
    files.map((item) => `${item.sha256}  ${item.file}\n`).join("")
  )
    throw new Error("发行校验文件不一致");
  return release;
}

if (require.main === module) {
  const verification = process.argv[2] === "--verify";
  const directory = path.resolve(process.argv[verification ? 3 : 2] || ".runtime/github-release");
  (verification ? verify(directory) : prepare(directory))
    .then((result) => console.log(`发行附件检查通过：${result.version} ${result.commit}`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { validateCandidate, verifyFiles, prepare, verify };
