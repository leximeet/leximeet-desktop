"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const workflow = fs.readFileSync(path.join(__dirname, "../../.github/workflows/ci.yml"), "utf8");
const setup = fs.readFileSync(
  path.join(__dirname, "../../.github/actions/setup-ci/action.yml"),
  "utf8",
);

test("CI 按平台拆开 smoke，lint 不阻塞，超时与 concurrency 符合编排", () => {
  assert.equal(workflow.includes("group: ${{ github.workflow }}-${{ github.ref }}"), true);
  assert.equal(
    workflow.includes("cancel-in-progress: ${{ github.event_name == 'pull_request'"),
    true,
  );
  assert.equal(workflow.includes("refs/tags/"), true);
  assert.equal(/name: Format, documents and audit[\s\S]*?timeout-minutes: 5/.test(workflow), true);
  assert.equal(/name: macOS verify[\s\S]*?timeout-minutes: 30/.test(workflow), true);
  assert.equal(/name: macOS journey[\s\S]*?timeout-minutes: 25/.test(workflow), true);
  assert.equal(/name: macOS package[\s\S]*?timeout-minutes: 25/.test(workflow), true);
  assert.equal(/name: Ubuntu core-cross[\s\S]*?timeout-minutes: 25/.test(workflow), true);
  assert.equal(/name: Windows core-cross[\s\S]*?timeout-minutes: 20/.test(workflow), true);
  assert.equal(/name: Windows package[\s\S]*?timeout-minutes: 25/.test(workflow), true);
  assert.equal(
    /name: Install smoke \(windows-2025, nsis\)[\s\S]*?needs: windows-package/.test(workflow),
    true,
  );
  assert.equal(workflow.includes("needs: ubuntu-package"), true);
  assert.equal(workflow.includes("if: ${{ !cancelled() }}"), false);
  assert.equal(workflow.includes("needs: desktop"), false);
  assert.equal(workflow.includes("needs: lint"), false);
  const packagePlaywright = fs.readFileSync(
    path.join(__dirname, "../../playwright.desktop-package.config.cjs"),
    "utf8",
  );
  assert.equal(packagePlaywright.includes("prepare-full-dictionary"), true);
  assert.equal(setup.includes("cache: maven"), true);
  assert.equal(setup.includes(".runtime/electron-cache"), true);
  assert.equal(setup.includes(".runtime/dictionary-source"), true);
  assert.equal(setup.includes("text-dictionary-index.cjs"), true);
  assert.equal(workflow.includes(".runtime/electron-builder"), true);
  assert.equal(workflow.includes("protectWindowsPath"), true);
});
