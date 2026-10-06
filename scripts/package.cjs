const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
// 打包工具的下载缓存也留在项目构建空间，不要求写用户 Library/Caches。
process.env.ELECTRON_BUILDER_CACHE ||= path.resolve(__dirname, "../.runtime/electron-builder");
const { build, Platform, Arch } = require("electron-builder");
const { buildRuntime } = require("./build-runtime.cjs");
const root = path.resolve(__dirname, "..");
const { newPackageOutput, savePackagePointer } = require("./lib/package-output.cjs");
const { writeBuildManifest, sourceState } = require("./lib/build-manifest.cjs");
let attempt;

async function main() {
  const mode = process.argv[2] || "dir";
  if (!["dir", "dist"].includes(mode)) throw new Error("只支持 dir / dist");
  const version = process.env.LEXIMEET_BUILD_VERSION || require("../package.json").version;
  if (version && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("LEXIMEET_BUILD_VERSION 必须是版本号");
  const output = newPackageOutput(root, {
    version,
    platform: process.platform,
    arch: process.arch,
  });
  attempt = { output, version };
  if (process.env.LEXIMEET_ACCEPTANCE_APP !== "1")
    savePackagePointer(root, output, version, "building");
  if (fs.existsSync(output) && fs.readdirSync(output).length)
    throw new Error("构建输出目录已有文件，请指定一个新的 LEXIMEET_BUILD_OUTPUT");
  const sources = { desktop: sourceState(root), core: sourceState(path.join(root, "core-java")) };
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  const electronInstall = spawnSync(
    process.execPath,
    [path.join(__dirname, "install-electron.cjs")],
    { stdio: "inherit" },
  );
  if (electronInstall.error || electronInstall.status !== 0)
    throw electronInstall.error || new Error("Electron 二进制安装失败");
  require("./lmcp/verify-contract.cjs").verifyContract();
  buildRuntime();
  require("./lmcp/build-host.cjs").buildNativeHost();
  const platform = Platform.current();
  const target =
    mode === "dir"
      ? ["dir"]
      : process.platform === "darwin"
        ? ["dmg", "zip"]
        : process.platform === "win32"
          ? ["nsis"]
          : ["AppImage"];
  // 通过 API 固定当前架构，避免 ARM 主机把自身 JRE 塞进 x64 安装包。
  await build({
    projectDir: root,
    targets: platform.createTarget(target, Arch[process.arch]),
    publish: "never",
    config: {
      directories: { output },
      ...(process.env.LEXIMEET_ACCEPTANCE_APP === "1"
        ? {
            appId: "org.leximeet.desktop.acceptance",
            productName: "LexiMeet Acceptance",
          }
        : {}),
      ...(version ? { extraMetadata: { version } } : {}),
    },
  });
  await writeBuildManifest({ root, output, mode, version, sources });
  if (process.env.LEXIMEET_ACCEPTANCE_APP !== "1") savePackagePointer(root, output, version);
  console.log(`本轮构建完成：${output}`);
  console.log("文件摘要与来源：BUILD-MANIFEST.json / SHA256SUMS；仅生成本地文件，没有发布。");
}
main().catch((error) => {
  if (attempt && process.env.LEXIMEET_ACCEPTANCE_APP !== "1")
    savePackagePointer(root, attempt.output, attempt.version, "failed");
  console.error(error);
  process.exit(1);
});
