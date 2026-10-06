const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveProfile } = require("../../electron/services/profiles.cjs");

test("演示运行每次独立，正式与开发库不会互相覆盖", (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-profiles-test-"));
  const userData = path.join(projectDir, "formal");
  const dev = resolveProfile({ name: "dev", projectDir, userData });
  const local = resolveProfile({ name: "local", projectDir, userData });
  const a = resolveProfile({ name: "demo", projectDir, userData });
  const b = resolveProfile({ name: "demo", projectDir, userData });
  t.after(() => {
    for (const root of [projectDir, a.root, b.root])
      fs.rmSync(root, { recursive: true, force: true });
  });
  assert.equal(new Set([dev.root, local.root, a.root, b.root]).size, 4);
  assert.equal(local.root, path.join(userData, "workspaces", "v1"));
  assert.equal(dev.root, path.join(projectDir, ".runtime", "dev-v1"));
  assert.throws(() => resolveProfile({ name: "demo", dataDir: local.root }), /属于 local/);
  assert.throws(() => resolveProfile({ name: "test", dataDir: "./relative" }), /绝对路径/);
});

test("首次正式运行使用稳定的 v1 资料空间，旧试用库原地保留", (t) => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-profile-v1-"));
  t.after(() => fs.rmSync(projectDir, { recursive: true, force: true }));
  const userData = path.join(projectDir, "formal");
  fs.mkdirSync(path.join(userData, "core"), { recursive: true });
  const oldFile = path.join(userData, "core", "leximeet.sqlite");
  const oldBytes = Buffer.from("old unpublished trial database");
  fs.writeFileSync(oldFile, oldBytes);
  const first = resolveProfile({ name: "local", projectDir, userData });
  const reopened = resolveProfile({ name: "local", projectDir, userData });
  assert.equal(first.root, reopened.root);
  assert.notEqual(first.coreDir, path.dirname(oldFile));
  assert.deepEqual(fs.readFileSync(oldFile), oldBytes);
  assert.deepEqual(fs.readdirSync(first.coreDir), []);
  const explicit = path.join(projectDir, "explicit");
  assert.equal(resolveProfile({ name: "local", dataDir: explicit }).root, explicit);
});
