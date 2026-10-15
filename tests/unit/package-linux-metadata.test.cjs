"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const pkg = require("../../package.json");

test("Linux deb 含 maintainer 与项目主页，满足 electron-builder FpmTarget", () => {
  assert.equal(pkg.homepage, "https://github.com/leximeet/leximeet-desktop");
  assert.equal(pkg.repository.url, "https://github.com/leximeet/leximeet-desktop.git");
  assert.match(
    pkg.build.linux.maintainer,
    /^LexiMeet contributors <leximeet@users\.noreply\.github\.com>$/,
  );
  assert.equal(pkg.build.deb.packageName, "leximeet");
});
