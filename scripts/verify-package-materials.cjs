"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { extractFile, listPackage } = require("@electron/asar");

const BUILD_ONLY_PACKAGES = Object.freeze([
  "got",
  "cacheable-request",
  "http-cache-semantics",
  "electron-builder",
  "app-builder-lib",
]);

// 构建工具的上游风险不能偷偷进入运行包；同时检查嵌套 node_modules 与 unpacked 项。
function assertRuntimeDependencyBoundary(archive) {
  for (const file of listPackage(archive)) {
    const parts = file.replace(/\\/g, "/").split("/");
    for (let i = 0; i < parts.length - 1; i++)
      if (parts[i] === "node_modules" && BUILD_ONLY_PACKAGES.includes(parts[i + 1]))
        throw new Error(`运行包包含仅用于构建的依赖：${parts[i + 1]}`);
  }
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
// 大词典用固定缓冲区顺序读取，不同时将两份 SQLite 整库放入内存。
function fileDigest(filename) {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(1024 * 1024);
  const handle = fs.openSync(filename, "r");
  try {
    let size;
    while ((size = fs.readSync(handle, buffer, 0, buffer.length, null)))
      hash.update(buffer.subarray(0, size));
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
}

// 只读实际包；JRE 的内部许可软链允许保留，但不能越出指定物料目录。
function readWithin(directory, relative) {
  let root, file;
  try {
    root = fs.realpathSync(directory);
    file = fs.realpathSync(path.join(directory, relative));
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error.code)) throw new Error(`缺少物料原文：${relative}`);
    throw error;
  }
  if (!file.startsWith(root + path.sep) || !fs.statSync(file).isFile())
    throw new Error(`物料越界或不是文件：${relative}`);
  const bytes = fs.readFileSync(file);
  if (!bytes.length) throw new Error(`物料为空：${relative}`);
  return bytes;
}

function filesWithin(directory, prefix = "") {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(prefix, entry.name);
    return entry.isDirectory() ? filesWithin(directory, relative) : [relative];
  });
}

// 源 Jar/SBOM 先由 Core 的 verify-release.py 校验；此处确认实际包未换成另一份物料。
function verifyPackageMaterials({ projectDir, resourcesDir }) {
  const checked = [];
  const compare = (target, source, readTarget = () => readWithin(resourcesDir, target)) => {
    const expected = readWithin(projectDir, source);
    const actual = readTarget();
    if (!actual.equals(expected)) throw new Error(`实际包物料与本轮来源不一致：${target}`);
    checked.push({ path: target, sha256: sha256(actual) });
  };
  const archive = path.join(resourcesDir, "app.asar");
  assertRuntimeDependencyBoundary(archive);
  const fromAsar = (file) => () => extractFile(archive, file, false);
  for (const file of ["LICENSE", "frontend/src/assets/audio/NOTICE.md"])
    compare(`app.asar/${file}`, file, fromAsar(file));
  // 公开资源许可与协议冻结物料都按原字节随包，不仅检查文件名存在。
  for (const folder of ["resources/licenses", "resources/lmcp"])
    for (const relative of filesWithin(path.join(projectDir, folder))) {
      const file = `${folder}/${relative}`;
      compare(`app.asar/${file}`, file, fromAsar(file));
    }
  // 同时核对实际业务字节，避免新许可证配上旧前端或旧 Main 仍被误认为当前候选。
  for (const folder of ["electron", "frontend/dist"])
    for (const relative of filesWithin(path.join(projectDir, folder))) {
      const file = `${folder}/${relative}`;
      compare(`app.asar/${file}`, file, fromAsar(file));
    }
  compare("core/leximeet-core.jar", "core-java/target/leximeet-core.jar");
  const configuration = JSON.parse(readWithin(projectDir, "package.json"));
  const dictionary = configuration.build.extraResources.find((entry) => entry.to === "dictionary");
  if (!dictionary?.filter?.includes("DATA-LICENSE.md") || !dictionary.filter.includes("LICENSE"))
    throw new Error("打包配置没有明确保留公共词典许可");
  for (const file of dictionary.filter.filter(
    (name) => name === "LICENSE" || /\.(md|txt|json)$/.test(name),
  ))
    compare(`dictionary/${file}`, `${dictionary.from}/${file}`);
  for (const file of dictionary.filter.filter(
    (name) => !/\.(md|txt|json)$/.test(name) && name !== "LICENSE",
  )) {
    const source = path.join(projectDir, dictionary.from, file),
      target = path.join(resourcesDir, "dictionary", file);
    if (
      !fs.statSync(source).isFile() ||
      !fs.statSync(target).isFile() ||
      fs.statSync(source).size === 0
    )
      throw new Error(`词典正文缺失或无效：${file}`);
    const expected = fileDigest(source),
      actual = fileDigest(target);
    if (expected !== actual) throw new Error(`实际包物料与本轮来源不一致：dictionary/${file}`);
    checked.push({ path: `dictionary/${file}`, sha256: actual });
  }
  for (const file of ["LICENSE", "LICENSES.chromium.html"])
    compare(`electron-licenses/${file}`, `node_modules/electron/dist/${file}`);
  const legalSource = path.join(projectDir, ".runtime/jre/legal");
  const legalFiles = filesWithin(legalSource);
  if (!legalFiles.includes("java.base/LICENSE")) throw new Error("随包 JRE 来源缺少基本许可");
  for (const file of legalFiles) {
    const expected = readWithin(legalSource, file);
    const actual = readWithin(path.join(resourcesDir, "runtime/legal"), file);
    if (!actual.equals(expected)) throw new Error(`随包 JRE 许可与来源不一致：${file}`);
    checked.push({ path: `runtime/legal/${file}`, sha256: sha256(actual) });
  }
  const host = JSON.parse(readWithin(resourcesDir, "native-host/bundle.json"));
  const hostSources = {
    "host/main.cjs": "electron/native-host/main.cjs",
    "services/lmcp/framing.cjs": "electron/services/lmcp/framing.cjs",
    "services/lmcp/private-files.cjs": "electron/services/lmcp/private-files.cjs",
  };
  if (
    host.format !== "leximeet.native-host-bundle/1" ||
    host.entry !== "host/main.cjs" ||
    host.files?.length !== 3
  )
    throw new Error("Native Host 清单不是固定三项物料");
  const seen = new Set();
  for (const file of host.files) {
    if (!hostSources[file.path] || seen.has(file.path))
      throw new Error("Native Host 清单重复或越界");
    seen.add(file.path);
    compare(`native-host/${file.path}`, hostSources[file.path]);
    if (checked.at(-1).sha256 !== file.sha256)
      throw new Error("Native Host 原文件与清单摘要不一致");
  }
  return {
    status: "passed",
    checkedFiles: checked.length,
    files: checked,
    runtimeDependencyBoundary: { status: "passed", excludedBuildPackages: BUILD_ONLY_PACKAGES },
    scope: "实际包许可、冻结物料及来源字节；不启动应用、不代表 UI 或发布通过",
  };
}

// 找唯一物料目录，拒绝在多个旧候选中随便选一份。
function findResources(directory) {
  const found = [];
  function visit(folder, depth) {
    if (fs.existsSync(path.join(folder, "app.asar"))) {
      found.push(folder);
      return;
    }
    if (depth >= 4) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true }))
      if (entry.isDirectory()) visit(path.join(folder, entry.name), depth + 1);
  }
  visit(directory, 0);
  if (found.length !== 1) throw new Error(`需要唯一实际包 Resources，找到 ${found.length} 个`);
  return found[0];
}

if (require.main === module) {
  try {
    if (process.argv.length > 3) throw new Error("只接受一个构建输出目录");
    const projectDir = path.resolve(__dirname, "..");
    const directory = process.argv[2]
      ? path.resolve(projectDir, process.argv[2])
      : require("./lib/package-output.cjs").resolvePackageOutput(projectDir);
    console.log(
      JSON.stringify(
        verifyPackageMaterials({ projectDir, resourcesDir: findResources(directory) }),
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { verifyPackageMaterials, findResources };
