"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { canonical } = require("../../electron/services/lmcp/host-operations.cjs");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const EXPECTED_VERSION = "1.0.0";
const EXPECTED_DIGEST = "61a44cc2f7f73fef81b007c844e1f2fa4deb955bf21a69236ee7b4f713808c49";
// 运行和构建只消费随仓固定物料；不读取并行开发中的相邻协议仓。
function verifyContract(directory = path.resolve(__dirname, "../../resources/lmcp")) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
  const contract = read("contract.json"),
    manifest = read("contract-manifest.json");
  if (contract.packageVersion !== EXPECTED_VERSION || contract.contractDigest !== EXPECTED_DIGEST)
    throw new Error("LMCP 身份不是本应用固定的 1.0.0 快照");
  if (
    manifest.contractVersion !== contract.packageVersion ||
    manifest.algorithm !== "sha256-jcs-manifest/1" ||
    manifest.manifestVersion !== 1
  )
    throw new Error("LMCP 契约清单格式不一致");
  const { contractDigest, ...configuration } = contract;
  if (
    sha256(canonical(configuration)) !== manifest.configurationSha256 ||
    sha256(canonical(manifest)) !== contractDigest
  )
    throw new Error("LMCP 契约身份摘要不一致");
  const seen = new Set();
  for (const item of manifest.files) {
    if (
      !item.path ||
      item.path.startsWith("/") ||
      item.path.includes("\\") ||
      item.path.split("/").includes("..") ||
      seen.has(item.path)
    )
      throw new Error("LMCP 规范路径无效");
    seen.add(item.path);
    const file = path.join(directory, item.path);
    const realRoot = fs.realpathSync(directory);
    if (!fs.realpathSync(file).startsWith(`${realRoot}${path.sep}`) || !fs.statSync(file).isFile())
      throw new Error("LMCP 规范物料越出固定目录");
    if (sha256(fs.readFileSync(file)) !== item.sha256)
      throw new Error(`LMCP 规范物料改变：${item.path}`);
  }
  const required = [
    "methods.json",
    "host-methods.json",
    "schemas/desktop-api.v1.schema.json",
    "schemas/browser-host.v1.schema.json",
    "schemas/reading-domain.v1.schema.json",
    "schemas/dictionary-entry.v2.schema.json",
    "extensions.json",
  ];
  if (required.some((file) => !seen.has(file))) throw new Error("LMCP 清单缺少必需物料");
  return {
    version: contract.packageVersion,
    digest: contractDigest,
    files: manifest.files.length,
  };
}
if (require.main === module) {
  try {
    console.log(JSON.stringify(verifyContract(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifyContract };
