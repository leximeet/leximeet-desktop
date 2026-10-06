const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { compareVersion } = require("../helpers/versions.cjs");
const { requireExecutable } = require("../helpers/electron-fixture.cjs");
const { assertInstaller } = require("../../scripts/lib/installer.cjs");
const { findArtifact } = require("../../scripts/artifacts.cjs");

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-testing-tools-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function file(root, name) {
  const filename = path.join(root, name);
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, "isolated test fixture", { mode: 0o755 });
  return filename;
}

test("升级闸门：相同版本/仅build metadata变化不算升级，候选版按SemVer比较", () => {
  assert.equal(compareVersion("0.1.0", "0.1.0"), 0);
  assert.equal(compareVersion("0.1.0+rebuild.2", "0.1.0+rebuild.1"), 0);
  assert.equal(compareVersion("0.1.1-test.1", "0.1.0"), 1);
  assert.equal(compareVersion("0.1.0-rc.1", "0.1.0"), -1);
  assert.equal(compareVersion("0.1.0-rc.10", "0.1.0-rc.2"), 1);
  assert.equal(compareVersion("0.1.0-beta", "0.1.0-1"), 1);
  assert.equal(compareVersion("0.1.0-alpha.1", "0.1.0-alpha"), 1);
  for (const version of ["0.1", "01.1.0", "1.0.0-01", "1.0.0-alpha..1", "latest"]) {
    assert.throws(() => compareVersion(version, "1.0.0"), /SemVer/);
  }
});

test("可执行文件闸门：缺参、相对路径、目录和不存在文件必须失败", (t) => {
  const root = directory(t);
  assert.throws(() => requireExecutable(undefined, "CANDIDATE"), /缺少 CANDIDATE/);
  assert.throws(() => requireExecutable("LexiMeet", "CANDIDATE"), /绝对路径/);
  assert.throws(() => requireExecutable(root, "CANDIDATE"), /现有可执行文件/);
  assert.throws(() => requireExecutable(path.join(root, "missing"), "CANDIDATE"), /现有可执行文件/);
  const executable = file(root, process.platform === "win32" ? "LexiMeet.exe" : "LexiMeet");
  assert.equal(requireExecutable(executable, "CANDIDATE"), fs.realpathSync(executable));
  if (process.platform !== "win32") {
    fs.chmodSync(executable, 0o644);
    assert.throws(() => requireExecutable(executable, "CANDIDATE"), /EACCES/);
  }
});

test("Windows安装副作用闸门：开发机与self-hosted不能仅靠CI=true绕过", (t) => {
  const root = directory(t);
  const installer = file(root, "LexiMeet Setup.exe");
  for (const env of [
    {},
    { CI: "true" },
    { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "self-hosted" },
  ]) {
    assert.throws(() => assertInstaller(installer, "win32", env), /一次性 Windows VM/);
  }
  assert.doesNotThrow(() =>
    assertInstaller(installer, "win32", {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
    }),
  );
  assert.doesNotThrow(() =>
    assertInstaller(installer, "win32", { LEXIMEET_DISPOSABLE_MACHINE: "1" }),
  );
  assert.throws(() => assertInstaller(installer, "darwin", {}), /类型与当前操作系统不符/);
  assert.throws(() => assertInstaller("relative.exe", "win32", {}), /绝对路径/);
});

test("产物查找：拒绝空目录和同时残留的新旧包，不会默默选中旧包", (t) => {
  const root = directory(t);
  assert.throws(() => findArtifact("executable", root), /找到 0 个/);
  const suffix =
    process.platform === "darwin"
      ? "LexiMeet.app/Contents/MacOS/LexiMeet"
      : process.platform === "win32"
        ? "LexiMeet.exe"
        : "leximeet";
  const previous = file(root, `previous/${suffix}`);
  assert.equal(findArtifact("executable", root), previous);
  file(root, `candidate/${suffix}`);
  assert.throws(() => findArtifact("executable", root), /找到 2 个/);
});

test("安装器查找：忽略unpacked中的exe，多个分发包明确报歧义", (t) => {
  const root = directory(t);
  const extension = { darwin: ".dmg", win32: ".exe", linux: ".AppImage" }[process.platform];
  file(root, `win-unpacked/LexiMeet${extension}`);
  assert.throws(() => findArtifact("installer", root), /找到 0 个/);
  const candidate = file(root, `LexiMeet-0.1.1${extension}`);
  assert.equal(findArtifact("installer", root), candidate);
  file(root, `LexiMeet-0.1.0${extension}`);
  assert.throws(() => findArtifact("installer", root), /找到 2 个/);
});
