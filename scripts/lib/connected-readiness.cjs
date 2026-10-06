"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash, createPublicKey } = require("node:crypto");

const CONTRACT_VERSION = "1.0.0";
const CONTRACT_DIGEST = "61a44cc2f7f73fef81b007c844e1f2fa4deb955bf21a69236ee7b4f713808c49";
const NATIVE_HOST = "org.leximeet.browser";
const REQUIRED_PERMISSIONS = Object.freeze([
  "activeTab",
  "scripting",
  "storage",
  "sidePanel",
  "nativeMessaging",
  "alarms",
  "notifications",
]);
const DEFAULT_EXTENSION = path.resolve(
  __dirname,
  "../../../plugin/leximeet-browser/.output/chrome-mv3",
);
const MAX_JSON_BYTES = 256 * 1024;

// CLI 不允许任意资料目录、浏览器路径或注册目标；隔离根只能由启动器新建。
function parseArguments(argv) {
  const result = { mode: "start", extensionDir: DEFAULT_EXTENSION };
  let operation = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--help", "--check", "--fresh", "--cleanup"].includes(arg)) {
      if (operation) throw new Error("只能选择 --help、--check、--fresh 或 --cleanup 中的一项");
      operation = arg;
      result.mode = arg === "--fresh" ? "start" : arg.slice(2);
      if (arg === "--cleanup") {
        const id = argv[++i];
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id || ""))
          throw new Error("--cleanup 需要完整会话 UUID，不能传入路径");
        result.sessionId = id;
      }
    } else if (arg === "--extension") {
      if (result.explicitExtension || !argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error("--extension 需要唯一的构建目录");
      const value = argv[++i];
      if (/[\0\r\n]/.test(value)) throw new Error("扩展目录无效");
      result.extensionDir = path.resolve(value);
      result.explicitExtension = true;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (["help", "cleanup"].includes(result.mode) && result.explicitExtension)
    throw new Error(`--${result.mode} 不接受其他参数`);
  return result;
}

// 不跟随构建目录中的软链接，避免复制时带入用户目录或读取不明文件。
function assertPlainTree(directory) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("扩展构建目录必须是真实目录");
  let count = 0;
  function visit(folder) {
    for (const name of fs.readdirSync(folder)) {
      if (++count > 100000) throw new Error("扩展构建文件过多");
      const file = path.join(folder, name);
      const item = fs.lstatSync(file);
      if (item.isSymbolicLink() || (!item.isFile() && !item.isDirectory()))
        throw new Error("扩展构建不能包含软链接或特殊文件");
      if (item.isDirectory()) visit(file);
    }
  }
  visit(directory);
}
function readJson(directory, name) {
  const file = path.join(directory, name);
  if (!fs.existsSync(file)) throw new Error(`缺少 ${name}`);
  const stat = fs.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_JSON_BYTES)
    throw new Error(`${name} 不是有效的小型 JSON 文件`);
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new Error(`${name} JSON 无效`);
  }
}

// Chrome 用公开 DER key 的 SHA-256 前 128 位映射 a-p，复制到新目录后 ID 仍稳定。
function deriveExtensionId(key) {
  if (typeof key !== "string" || key.length > 16384 || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
    throw new Error("manifest.key 必须是 Base64 DER 公钥，不能使用私钥");
  const der = Buffer.from(key, "base64");
  if (!der.length || der.toString("base64") !== key) throw new Error("manifest.key Base64 非规范");
  try {
    createPublicKey({ key: der, format: "der", type: "spki" });
  } catch {
    throw new Error("manifest.key 不是有效的 SPKI 公钥");
  }
  return [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .map((byte) => String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)))
    .join("");
}
function manifestVersion(value) {
  if (typeof value !== "string" || !/^\d+(?:\.\d+){2,3}$/.test(value))
    throw new Error("manifest.version 必须是 Chromium 数字版本（至少 1.0.0）");
  const parts = value.split(".").map(Number);
  if (parts.some((n) => !Number.isSafeInteger(n) || n > 65535) || parts[0] < 1)
    throw new Error("插件构建仍低于 1.0.0，不能启动 1.0.0 联合验收");
  return parts.slice(0, 3).join(".");
}

// 只核验构建声明，完全不启动进程、不创建目录、不改原 manifest。
function checkReadiness(extensionDir = DEFAULT_EXTENSION) {
  const directory = path.resolve(extensionDir);
  if (!fs.existsSync(directory))
    throw new Error("找不到 Browser 构建；请先在插件项目构建 1.0.0 连接候选");
  assertPlainTree(directory);
  const manifest = readJson(directory, "manifest.json");
  if (manifest.manifest_version !== 3) throw new Error("只支持 Chromium Manifest V3 构建");
  const baseVersion = manifestVersion(manifest.version);
  if (
    !Array.isArray(manifest.permissions) ||
    REQUIRED_PERMISSIONS.some((permission) => !manifest.permissions.includes(permission))
  )
    throw new Error(`Browser 尚未声明本轮阅读采集权限：${REQUIRED_PERMISSIONS.join("、")}`);
  // 无固定 key 的生产构建同样合法。扩展 ID 必须从本轮实际 Chromium 观察，不能补 key。
  const extensionId = manifest.key ? deriveExtensionId(manifest.key) : null;
  const declaration = readJson(directory, "lmcp-readiness.json");
  if (
    declaration.contractVersion !== CONTRACT_VERSION ||
    declaration.contractDigest !== CONTRACT_DIGEST
  )
    throw new Error("Browser 构建的 1.0.0 契约版本或摘要不一致");
  if (declaration.apiVersion !== "1.0.0" || declaration.nativeHost !== NATIVE_HOST)
    throw new Error("Browser API 版本或 Native Host 名称不是当前约定");
  if (!/^[a-f0-9]{40}$/.test(declaration.sourceCommit || ""))
    throw new Error("Browser 构建缺少有效的源码提交声明");
  if (typeof declaration.jointAcceptancePassed !== "boolean")
    throw new Error("Browser 准备声明缺少联合验收状态；声明本身不是行为验收");
  for (const [name, value] of [
    ["background service_worker", manifest.background?.service_worker],
    ["options_ui.page", manifest.options_ui?.page],
    ["side_panel.default_path", manifest.side_panel?.default_path],
  ]) {
    if (
      typeof value !== "string" ||
      !value ||
      /[\0\r\n]/.test(value) ||
      path.isAbsolute(value) ||
      value.split(/[\\/]/).includes("..") ||
      !fs.existsSync(path.join(directory, value)) ||
      !fs.statSync(path.join(directory, value)).isFile()
    )
      throw new Error(`缺少有效的构建入口：${name}`);
  }
  return {
    ready: true,
    evidenceKind: "build-declaration-only",
    extensionDir: directory,
    applicationVersion: manifest.version_name || baseVersion,
    extensionId,
    contractVersion: CONTRACT_VERSION,
    contractDigest: CONTRACT_DIGEST,
    nativeHost: NATIVE_HOST,
    sourceCommit: declaration.sourceCommit,
    optionsPage: manifest.options_ui.page,
    panelPage: manifest.side_panel.default_path,
    permissions: [...REQUIRED_PERMISSIONS],
    productionHashes: treeHashes(directory),
  };
}

// 逐文件指纹用于核对原样复制、重启与退出；不把协议声明当作源码或行为证明。
function treeHashes(directory, prefix = "") {
  assertPlainTree(directory);
  const hashes = {};
  function visit(folder, current) {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name),
        relative = path.posix.join(current, name);
      if (fs.statSync(file).isDirectory()) visit(file, relative);
      else hashes[relative] = createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    }
  }
  visit(directory, prefix);
  return hashes;
}

module.exports = {
  CONTRACT_VERSION,
  CONTRACT_DIGEST,
  NATIVE_HOST,
  REQUIRED_PERMISSIONS,
  DEFAULT_EXTENSION,
  parseArguments,
  deriveExtensionId,
  treeHashes,
  checkReadiness,
};
