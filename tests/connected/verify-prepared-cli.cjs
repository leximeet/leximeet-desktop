"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { connectedSessionRoot } = require("../../scripts/lib/connected-session-path.cjs");

// 单独证明人工一键准备分支；后台启动当前真实包，不能把已有包测试冒充冷启动准备。
async function main() {
  const output = process.env.LEXIMEET_CLI_EVIDENCE;
  if (!output || !path.isAbsolute(output))
    throw new Error("请设置绝对路径 LEXIMEET_CLI_EVIDENCE 保存本轮私有记录");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const fd = fs.openSync(path.join(output, "cli.log"), "w", 0o600);
  const child = spawn(process.execPath, [path.join(__dirname, "fixtures/packaged-cli.cjs")], {
    cwd: path.resolve(__dirname, "../.."),
    detached: true,
    env: {
      ...process.env,
      LEXIMEET_CLI_PREPARE: "1",
      LEXIMEET_CONNECTED_PACKAGE_ROOT: "",
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => fs.writeSync(fd, bytes));
  let metadata, result, timer;
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error("正常准备超时，保留 cli.log；不降级已有包")), 900000);
    child.on("message", (message) => {
      if (message.type === "ready") {
        metadata = message.value;
        resolve();
      }
      if (message.type === "closed") result = message.value;
    });
    child.once("exit", (code) => reject(new Error(`正常 CLI 准备就绪前退出 ${code}，见 cli.log`)));
  });
  try {
    await ready;
    clearTimeout(timer);
    assert.equal(path.dirname(metadata.directory), connectedSessionRoot());
    assert.equal(child.kill("SIGINT"), true);
    assert.deepEqual(await exited, { code: 130, signal: null });
    assert.equal(result.headless, true);
    assert.equal(result.application.packaged, true);
    assert.equal(result.application.hostJavaPoisoned, true);
    assert.equal(result.packagedArtifacts.dictionaryIndex.indexVersion, 3);
    assert.equal(result.focus.complete, true);
    assert.deepEqual(result.focus.violations, []);
    assert.deepEqual(result.background.violations, []);
    assert.deepEqual(result.cleanupErrors, []);
    assert.equal(result.productionBytesUnchanged, true);
    assert.equal(result.artifactsReclaimed, true);
    for (const folder of ["application", "desktop", "browser-extension"])
      assert.equal(fs.existsSync(path.join(metadata.directory, folder)), false);
    assert.equal(fs.existsSync(result.registration.manifestPath), false);
    for (const pid of [
      ...Object.values(result.processes).map((item) => item.pid),
      result.browser.pid,
    ]) {
      let status = "present";
      try {
        process.kill(pid, 0);
      } catch (error) {
        status = error.code;
      }
      assert.equal(status, "ESRCH", `本轮进程 ${pid} 应已退出`);
    }
    const packageDirectory = path.join(metadata.directory, "application");
    const application = path.join(
      packageDirectory,
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "LexiMeet Acceptance.app",
    );
    assert.ok(result.application.resources.startsWith(application + path.sep));
    const proof = {
      passed: true,
      prepare: true,
      providedPackage: false,
      freshNetworkDownloadClaimed: false,
      packageDirectory,
      application,
      source: {
        browserCommit: require("node:child_process")
          .execFileSync("git", ["rev-parse", "HEAD"], {
            cwd: path.resolve(__dirname, "../../../plugin/leximeet-browser"),
            encoding: "utf8",
          })
          .trim(),
      },
      appAsarSha256: result.packagedArtifacts.appAsarSha256,
      coreJarSha256: result.packagedArtifacts.coreJarSha256,
      dictionaryIndex: result.packagedArtifacts.dictionaryIndex,
      nativeHostFiles: result.packagedArtifacts.nativeHostFiles,
      environment: result.environment,
      sigint: true,
      exitCode: 130,
      registrationRemoved: true,
      ownedPidsExited: true,
      dataRetained: false,
      artifactsReclaimed: result.artifactsReclaimed,
      recordRetained: fs.existsSync(path.join(metadata.directory, "acceptance.json")),
      focus: result.focus,
      cleanupErrors: result.cleanupErrors,
    };
    fs.writeFileSync(
      path.join(output, "normal-prepare.json"),
      JSON.stringify(proof, null, 2) + "\n",
      { mode: 0o600 },
    );
    console.log(
      JSON.stringify({
        passed: true,
        packageDirectory,
        appAsarSha256: proof.appAsarSha256,
        coreJarSha256: proof.coreJarSha256,
        focusViolations: proof.focus.violations.length,
      }),
    );
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    fs.closeSync(fd);
  }
}
main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
