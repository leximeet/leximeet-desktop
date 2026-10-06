"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pruneArtifacts } = require("../../scripts/prune-artifacts.cjs");

test("清理只删除包副本，保留 summary、包哈希和日志", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-prune-"));
  try {
    const run = path.join(root, "test-results", "workspace", "run-a");
    fs.mkdirSync(path.join(run, "package", "mac-arm64"), { recursive: true });
    fs.writeFileSync(path.join(run, "summary.json"), "{}\n");
    fs.writeFileSync(path.join(run, "package", "evidence.json"), "{}\n");
    fs.writeFileSync(path.join(run, "package", "LexiMeet.bin"), "bundle");
    fs.mkdirSync(path.join(root, ".runtime", "package-verify"), { recursive: true });
    fs.writeFileSync(path.join(root, ".runtime", "package-verify", "app.bin"), "x");
    fs.mkdirSync(path.join(root, "release"), { recursive: true });
    fs.writeFileSync(path.join(root, "release", "builder-debug.yml"), "keep\n");
    fs.mkdirSync(path.join(root, "release", "linux-unpacked"));
    const preview = pruneArtifacts({ root, release: true, dryRun: true });
    assert.equal(preview.length, 4);
    assert.equal(fs.existsSync(path.join(run, "package", "LexiMeet.bin")), true);
    assert.equal(fs.existsSync(path.join(root, "release", "linux-unpacked")), true);
    const removed = pruneArtifacts({ root, release: true });
    assert.deepEqual(removed, preview);
    assert.equal(fs.existsSync(path.join(run, "summary.json")), true);
    assert.equal(fs.existsSync(path.join(run, "package", "evidence.json")), true);
    assert.equal(fs.existsSync(path.join(root, ".runtime", "package-verify", "app.bin")), false);
    assert.equal(fs.existsSync(path.join(root, "release", "builder-debug.yml")), true);
    assert.equal(fs.existsSync(path.join(root, "release", "linux-unpacked")), false);
    assert.equal(removed.length, 4);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("清理遇到符号链接或验收锁时零删除", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-review-prune-"));
  try {
    const outside = path.join(root, "preserved");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "LexiMeet.bin"), "keep");
    const workspace = path.join(root, "test-results/workspace");
    fs.mkdirSync(workspace, { recursive: true });
    fs.symlinkSync(outside, path.join(workspace, "run"));
    assert.throws(() => pruneArtifacts({ root }), /符号链接/);
    assert.equal(fs.readFileSync(path.join(outside, "LexiMeet.bin"), "utf8"), "keep");
    fs.unlinkSync(path.join(workspace, "run"));
    fs.mkdirSync(path.join(root, ".runtime"));
    fs.writeFileSync(path.join(root, ".runtime/workspace-verification.lock"), String(process.pid));
    assert.throws(() => pruneArtifacts({ root }), /运行锁/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
