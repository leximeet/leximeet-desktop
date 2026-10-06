"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const asar = require("@electron/asar");
const {
  verifyPackageMaterials,
  findResources,
} = require("../../scripts/verify-package-materials.cjs");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

// 每例创建小型真实 ASAR 与独占资料，验证门禁而不是启动应用。
async function fixture(t) {
  const owned = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-package-materials-"));
  t.after(() => {
    asar.uncacheAll();
    fs.rmSync(owned, { recursive: true, force: true });
  });
  const projectDir = path.join(owned, "project");
  const resourcesDir = path.join(owned, "output/Example.app/Contents/Resources");
  const put = (root, relative, body) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  };
  const dictionary = [
    "LICENSE",
    "DATA-LICENSE.md",
    "notice-fixture.txt",
    "selection.json",
    "core-text.sqlite",
    "entries-lite.jsonl.zst",
  ];
  const sources = {
    LICENSE: "自有许可原文 fixture\n",
    "frontend/src/assets/audio/NOTICE.md": "音源原许可 fixture\n",
    "resources/licenses/dependency.txt": "依赖原许可 fixture\n",
    "resources/lmcp/contract.json": '{"apiVersion":"1.0.0"}',
    "core-java/target/leximeet-core.jar": "独占 Jar 字节 fixture",
    "node_modules/electron/dist/LICENSE": "Electron 原许可 fixture\n",
    "node_modules/electron/dist/LICENSES.chromium.html": "Chromium 原声明 fixture\n",
    ".runtime/jre/legal/java.base/LICENSE": "JRE 原许可 fixture\n",
    "electron/native-host/main.cjs": "main fixture",
    "electron/services/lmcp/framing.cjs": "framing fixture",
    "electron/services/lmcp/private-files.cjs": "private fixture",
    "frontend/dist/index.html": "本轮正式前端 fixture",
  };
  sources["package.json"] = JSON.stringify({
    build: {
      extraResources: [{ from: "resources/dictionary", to: "dictionary", filter: dictionary }],
    },
  });
  for (const file of dictionary) sources[`resources/dictionary/${file}`] = `词典 ${file} fixture`;
  for (const [file, body] of Object.entries(sources)) put(projectDir, file, body);
  fs.mkdirSync(resourcesDir, { recursive: true });
  await asar.createPackage(projectDir, path.join(resourcesDir, "app.asar"));
  put(resourcesDir, "core/leximeet-core.jar", sources["core-java/target/leximeet-core.jar"]);
  for (const file of dictionary)
    put(resourcesDir, `dictionary/${file}`, sources[`resources/dictionary/${file}`]);
  for (const file of ["LICENSE", "LICENSES.chromium.html"])
    put(resourcesDir, `electron-licenses/${file}`, sources[`node_modules/electron/dist/${file}`]);
  put(
    resourcesDir,
    "runtime/legal/java.base/LICENSE",
    sources[".runtime/jre/legal/java.base/LICENSE"],
  );
  const hostFiles = [
    ["host/main.cjs", "electron/native-host/main.cjs"],
    ["services/lmcp/framing.cjs", "electron/services/lmcp/framing.cjs"],
    ["services/lmcp/private-files.cjs", "electron/services/lmcp/private-files.cjs"],
  ].map(([file, source]) => {
    put(resourcesDir, `native-host/${file}`, sources[source]);
    return { path: file, sha256: hash(sources[source]) };
  });
  put(
    resourcesDir,
    "native-host/bundle.json",
    JSON.stringify({
      format: "leximeet.native-host-bundle/1",
      entry: "host/main.cjs",
      files: hostFiles,
    }),
  );
  return { owned, projectDir, resourcesDir, put };
}

test("实际包原文和来源一致，门禁只读且报告不含本机路径", async (t) => {
  const f = await fixture(t);
  const archive = path.join(f.resourcesDir, "app.asar");
  const before = hash(fs.readFileSync(archive));
  const report = verifyPackageMaterials(f);
  assert.equal(report.status, "passed");
  assert.equal(report.checkedFiles, 21);
  assert.equal(hash(fs.readFileSync(archive)), before);
  assert.equal(JSON.stringify(report).includes(f.owned), false);
  assert.equal(report.runtimeDependencyBoundary.status, "passed");
});

test("构建下载与缓存依赖进入实际 ASAR 时拒绝，嵌套或 unpacked 标记不能绕过", async (t) => {
  const f = await fixture(t);
  const archive = path.join(f.resourcesDir, "app.asar");
  for (const name of [
    "got",
    "cacheable-request",
    "http-cache-semantics",
    "electron-builder",
    "app-builder-lib",
  ]) {
    const relative = `node_modules/fixture-runtime/node_modules/${name}/package.json`;
    f.put(f.projectDir, relative, JSON.stringify({ name, version: "0.0.0" }));
    await asar.createPackageWithOptions(f.projectDir, archive, { unpack: `**/${name}/**` });
    asar.uncacheAll();
    assert.throws(
      () => verifyPackageMaterials(f),
      new RegExp(`运行包包含仅用于构建的依赖：${name}`),
    );
    fs.rmSync(path.join(f.projectDir, relative), { force: true });
    fs.rmSync(path.dirname(path.join(f.projectDir, relative)), { recursive: true, force: true });
  }
});

test("词典 SQLite 和压缩正文被损坏时拒绝生成完整清单", async (t) => {
  const f = await fixture(t);
  for (const file of ["core-text.sqlite", "entries-lite.jsonl.zst"]) {
    const original = fs.readFileSync(path.join(f.resourcesDir, "dictionary", file));
    f.put(f.resourcesDir, `dictionary/${file}`, "旧或损坏的正文");
    assert.throws(() => verifyPackageMaterials(f), /实际包物料与本轮来源不一致/);
    f.put(f.resourcesDir, `dictionary/${file}`, original);
  }
});

test("新许可不能掩盖旧业务源码，实际 ASAR 字节必须一致", async (t) => {
  const f = await fixture(t);
  f.put(f.projectDir, "frontend/dist/index.html", "改过的本轮前端");
  assert.throws(() => verifyPackageMaterials(f), /frontend\/dist\/index.html/);
});

test("缺失或篡改 Electron/Dictionary 许可拒绝放行", async (t) => {
  const f = await fixture(t);
  for (const file of [
    "electron-licenses/LICENSE",
    "electron-licenses/LICENSES.chromium.html",
    "dictionary/DATA-LICENSE.md",
    "dictionary/notice-fixture.txt",
  ]) {
    const target = path.join(f.resourcesDir, file),
      original = fs.readFileSync(target);
    fs.unlinkSync(target);
    assert.throws(() => verifyPackageMaterials(f));
    f.put(f.resourcesDir, file, "被替换的原文");
    assert.throws(() => verifyPackageMaterials(f), /与本轮来源不一致/);
    fs.writeFileSync(target, original);
  }
});

test("Jar 或 Native Host 清单与真实文件不同拒绝放行", async (t) => {
  const f = await fixture(t);
  f.put(f.resourcesDir, "core/leximeet-core.jar", "另一轮 Jar");
  assert.throws(() => verifyPackageMaterials(f), /core\/leximeet-core.jar/);
  f.put(
    f.resourcesDir,
    "core/leximeet-core.jar",
    fs.readFileSync(path.join(f.projectDir, "core-java/target/leximeet-core.jar")),
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(f.resourcesDir, "native-host/bundle.json")),
  );
  manifest.files[0].sha256 = "0".repeat(64);
  f.put(f.resourcesDir, "native-host/bundle.json", JSON.stringify(manifest));
  assert.throws(() => verifyPackageMaterials(f), /清单摘要不一致/);
});

test("JRE 许可允许内部链接，但拒绝外部链接与空原文", async (t) => {
  const f = await fixture(t),
    legal = "runtime/legal/java.base/LICENSE";
  const original = fs.readFileSync(path.join(f.resourcesDir, legal));
  f.put(f.resourcesDir, legal, "");
  assert.throws(() => verifyPackageMaterials(f), /物料为空/);
  f.put(f.resourcesDir, legal, original);
  fs.renameSync(path.join(f.resourcesDir, legal), path.join(f.resourcesDir, legal + ".original"));
  fs.symlinkSync("LICENSE.original", path.join(f.resourcesDir, legal));
  assert.equal(verifyPackageMaterials(f).status, "passed");
  fs.unlinkSync(path.join(f.resourcesDir, legal));
  f.put(f.owned, "outside.txt", original);
  fs.symlinkSync(path.join(f.owned, "outside.txt"), path.join(f.resourcesDir, legal));
  assert.throws(() => verifyPackageMaterials(f), /物料越界/);
});

test("多个构建目录不能任选旧包冒充本轮物料", async (t) => {
  const f = await fixture(t),
    output = path.join(f.owned, "output");
  assert.equal(findResources(output), f.resourcesDir);
  f.put(output, "Other.app/Contents/Resources/app.asar", "另一个候选");
  assert.throws(() => findResources(output), /找到 2 个/);
});
