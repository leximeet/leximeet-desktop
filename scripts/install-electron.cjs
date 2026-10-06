"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const packageFile = require.resolve("electron/package.json");
const definition = JSON.parse(fs.readFileSync(packageFile, "utf8"));
const installer = definition.bin?.["install-electron"];
if (!installer) throw new Error("当前 Electron 包没有 install-electron 命令");
const cacheRoot = path.resolve(__dirname, "../.runtime/electron-cache");
const packageDirectory = path.dirname(packageFile);
async function sha(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
async function matches(file, expected) {
  return fs.existsSync(file) && fs.statSync(file).isFile() && (await sha(file)) === expected;
}

async function prepareArchive() {
  const file = `electron-v${definition.version}-${process.platform}-${process.arch}.zip`;
  const expected = JSON.parse(fs.readFileSync(path.join(packageDirectory, "checksums.json")))[file];
  if (!/^[a-f0-9]{64}$/.test(expected || "")) throw new Error("当前平台没有官方 Electron 校验和");
  const url = `https://github.com/electron/electron/releases/download/v${definition.version}/${file}`;
  // 与 @electron/get 5 的 Cache 对齐：只在本项目写入，已有系统缓存只读且必须校验。
  const location = new URL(url);
  location.pathname = path.posix.dirname(location.pathname);
  const key = createHash("sha256").update(location.toString()).digest("hex");
  const directory = path.join(cacheRoot, key),
    target = path.join(directory, file);
  fs.mkdirSync(directory, { recursive: true });
  if (await matches(target, expected)) return;
  const existingRoot =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library/Caches/electron")
      : process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || os.tmpdir(), "electron/Cache")
        : path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "electron");
  const existing = path.join(existingRoot, key, file);
  if (await matches(existing, expected)) {
    fs.copyFileSync(existing, target);
    console.log("已校验并复用现有 Electron 下载缓存；不修改系统缓存。");
    return;
  }
  const temporary = `${target}.download-${randomUUID()}`;
  try {
    for (const proxy of [null, "http://127.0.0.1:7897", "http://127.0.0.1:12334"]) {
      console.log(`准备 Electron ${definition.version} / ${process.platform} / ${process.arch}…`);
      const result = spawnSync(
        "curl",
        [
          "-fLsS",
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
      if (!result.error && result.status === 0 && (await matches(temporary, expected))) {
        fs.renameSync(temporary, target);
        return;
      }
    }
    throw new Error("Electron 下载失败或校验不符，请检查网络或代理后重试");
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

async function main() {
  let installed = false;
  try {
    installed =
      fs
        .readFileSync(path.join(packageDirectory, "dist/version"), "utf8")
        .trim()
        .replace(/^v/, "") === definition.version &&
      fs.existsSync(path.join(packageDirectory, "path.txt"));
  } catch {}
  if (!installed) await prepareArchive();
  const env = {
    ...process.env,
    electron_config_cache: cacheRoot,
    ELECTRON_INSTALL_PLATFORM: process.platform,
    ELECTRON_INSTALL_ARCH: process.arch,
  };
  // npm ci 可先跳过二进制下载；显式安装步骤必须真正解压，不能继承这个临时开关。
  delete env.ELECTRON_SKIP_BINARY_DOWNLOAD;
  // 固定官方 URL 使安装器读取刚校验的项目缓存，仍由官方安装器完成第二次校验与解压。
  for (const key of Object.keys(env))
    if (
      /electron.*(?:mirror|custom|override)|force_no_cache|electron_use_remote_checksums/i.test(key)
    )
      delete env[key];
  const result = spawnSync(process.execPath, [path.resolve(packageDirectory, installer)], {
    stdio: "inherit",
    env,
    timeout: 300000,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error("Electron 官方安装器未完成");
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
