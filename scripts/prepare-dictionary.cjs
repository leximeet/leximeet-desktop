"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  MANIFEST_SHA,
  INDEX_VERSION,
  RELEASE_URL,
  digest,
  hashFile,
  manifest,
  assetsFor,
  buildIndex,
} = require("../electron/services/text-dictionary-index.cjs");
const root = path.resolve(__dirname, "..");

async function download(url, destination) {
  const temporary = `${destination}.download`;
  try {
    if (!url.startsWith("https://")) throw new Error("词典下载只接受 HTTPS");
    let received = false;
    for (const proxy of [null, "http://127.0.0.1:7897", "http://127.0.0.1:12334"]) {
      // Node 原生 fetch 不自动使用用户的代理变量；curl 提供一致的直连与代理回退。
      const status = await new Promise((resolve, reject) => {
        const child = spawn(
          "curl",
          [
            "-fL",
            "--connect-timeout",
            "10",
            "--max-time",
            "240",
            ...(proxy ? ["--proxy", proxy] : []),
            url,
            "-o",
            temporary,
          ],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", resolve);
      });
      if (status === 0) {
        received = true;
        break;
      }
    }
    if (!received) throw new Error("词典下载失败，请检查网络或代理");
    fs.renameSync(temporary, destination);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
async function prepareSource(edition = "core-text") {
  const local =
    process.env.LEXIMEET_DICTIONARY_SOURCE ||
    path.resolve(root, "../leximeet-dictionary/dist/v0.0.3");
  const bundled = path.join(root, "resources/dictionary");
  const sources = [local, bundled];
  for (const candidate of sources) {
    if (!fs.existsSync(path.join(candidate, "release.json"))) continue;
    const release = manifest(candidate);
    let complete = true;
    for (const name of assetsFor(release, edition)) {
      const file = path.join(candidate, name),
        asset = release.assets[name];
      if (
        !fs.existsSync(file) ||
        fs.statSync(file).size !== asset.bytes ||
        (await hashFile(file)) !== asset.sha256
      ) {
        complete = false;
        break;
      }
    }
    if (complete) return candidate;
  }
  const source = path.join(root, ".runtime/dictionary-source/v0.0.3");
  fs.mkdirSync(source, { recursive: true });
  const releaseFile = path.join(source, "release.json");
  if (!fs.existsSync(releaseFile) || digest(fs.readFileSync(releaseFile)) !== MANIFEST_SHA) {
    const existing = sources
      .map((item) => path.join(item, "release.json"))
      .find((file) => fs.existsSync(file) && digest(fs.readFileSync(file)) === MANIFEST_SHA);
    if (existing) fs.copyFileSync(existing, releaseFile);
    else await download(`${RELEASE_URL}release.json`, releaseFile);
  }
  const release = manifest(source);
  for (const name of assetsFor(release, edition)) {
    const file = path.join(source, name),
      asset = release.assets[name];
    if (
      fs.existsSync(file) &&
      fs.statSync(file).size === asset.bytes &&
      (await hashFile(file)) === asset.sha256
    )
      continue;
    let copied = false;
    for (const candidate of sources) {
      const existing = path.join(candidate, name);
      if (
        fs.existsSync(existing) &&
        fs.statSync(existing).size === asset.bytes &&
        (await hashFile(existing)) === asset.sha256
      ) {
        fs.copyFileSync(existing, file);
        copied = true;
        break;
      }
    }
    if (!copied) {
      console.log(`准备词典资源：${name}`);
      await download(`${RELEASE_URL}${name}`, file);
    }
    if (fs.statSync(file).size !== asset.bytes || (await hashFile(file)) !== asset.sha256)
      throw new Error(`词典资源校验失败：${name}`);
  }
  return source;
}
async function prepare({ edition = "core-text" } = {}) {
  const destination = path.join(root, "resources/dictionary");
  fs.mkdirSync(destination, { recursive: true });
  const source = await prepareSource(edition);
  const index = path.join(destination, `${edition}.sqlite`),
    infoFile = `${index}.json`;
  if (fs.existsSync(infoFile) && fs.existsSync(index)) {
    const existing = JSON.parse(fs.readFileSync(infoFile));
    if (
      existing.manifestSha === MANIFEST_SHA &&
      existing.indexVersion === INDEX_VERSION &&
      (await hashFile(index)) === existing.indexSha
    ) {
      console.log(`${edition} 索引已校验，无需重建。`);
      return existing;
    }
  }
  let last = 0;
  const info = await buildIndex({
    source,
    output: index,
    edition,
    onProgress: (progress) => {
      if (progress.entries - last >= 20000) {
        last = progress.entries;
        console.log(`建立词典索引 ${progress.entries} / ${progress.total}`);
      }
    },
  });
  fs.writeFileSync(infoFile, JSON.stringify(info, null, 2) + "\n");
  const release = manifest(source);
  fs.copyFileSync(path.join(source, "release.json"), path.join(destination, "release.json"));
  // 压缩 Core 与许可证随包，用于离线重建、增量升级的 SHA 复用和来源说明。
  for (const name of assetsFor(release, "core-text"))
    fs.copyFileSync(path.join(source, name), path.join(destination, name));
  console.log(`词典已准备：${info.entryCount} 词，索引 ${(info.indexBytes / 1e6).toFixed(1)} MB`);
  return info;
}
if (require.main === module)
  prepare({
    edition: process.argv.includes("--full") ? "full-text" : "core-text",
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { prepare, prepareSource, download };
