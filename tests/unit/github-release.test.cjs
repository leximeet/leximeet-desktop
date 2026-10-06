"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { validateCandidate, verifyFiles } = require("../../scripts/prepare-github-release.cjs");

function candidate() {
  const commit = "a".repeat(40),
    coreCommit = "b".repeat(40),
    hash = "c".repeat(64);
  return {
    tag: "1.0.0",
    commit,
    coreCommit,
    metadata: { version: "1.0.0", commit, platform: "darwin", arch: "arm64" },
    source: {
      version: "1.0.0",
      sources: [
        { repository: "leximeet-desktop", commit, file: "desktop-source.tar.gz", sha256: hash },
        {
          repository: "leximeet-desktop-core",
          commit: coreCommit,
          file: "core-source.tar.gz",
          sha256: hash,
        },
      ],
    },
    manifest: {
      version: "1.0.0",
      sources: { desktop: { commit, dirty: false }, core: { commit: coreCommit, dirty: false } },
      platform: "darwin",
      arch: "arm64",
      status: "complete",
      mode: "dist",
      verification: { materials: "passed", applicationStartup: "installed-application-passed" },
      artifacts: [
        { file: "LexiMeet-1.0.0-mac-arm64.dmg", sha256: hash },
        { file: "LexiMeet-1.0.0-mac-arm64.zip", sha256: hash },
      ],
    },
  };
}
test("发布拒绝未安装、脏源码、错版本、错 Core 或缺失源码的候选", () => {
  validateCandidate(candidate());
  for (const change of [
    (value) => {
      value.tag = "v1.0.0";
    },
    (value) => {
      value.manifest.verification.applicationStartup = "not-run";
    },
    (value) => {
      value.manifest.sources.desktop.dirty = true;
    },
    (value) => {
      value.manifest.sources.core.commit = "d".repeat(40);
    },
    (value) => {
      value.source.sources.pop();
    },
    (value) => {
      value.manifest.artifacts.pop();
    },
  ]) {
    const value = candidate();
    change(value);
    assert.throws(() => validateCandidate(value));
  }
});
test("发布附件逐字节核对，篡改或越界文件不会通过", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-release-check-"));
  try {
    fs.writeFileSync(path.join(directory, "installer.zip"), "verified");
    const file = {
      file: "installer.zip",
      bytes: 8,
      sha256: crypto.createHash("sha256").update("verified").digest("hex"),
    };
    await verifyFiles(directory, [file]);
    fs.writeFileSync(path.join(directory, file.file), "modified");
    await assert.rejects(verifyFiles(directory, [file]), /SHA-256/);
    await assert.rejects(
      verifyFiles(directory, [{ ...file, file: "../installer.zip" }]),
      /直接文件名/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
