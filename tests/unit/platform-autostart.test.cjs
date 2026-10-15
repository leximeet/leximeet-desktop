"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  setLinuxAutostart,
  linuxAutostartEnabled,
  renderDesktopEntry,
} = require("../../electron/services/platform/autostart.cjs");

test("Linux 开机自启尽力写 XDG desktop 项，关闭则删除", (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-autostart-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const executable = path.join(home, "leximeet");
  const enabled = setLinuxAutostart(true, { homeDir: home, executable });
  assert.equal(enabled.enabled, true);
  assert.match(fs.readFileSync(enabled.file, "utf8"), /X-GNOME-Autostart-enabled=true/);
  assert.match(renderDesktopEntry(executable), /Exec="[^"]*leximeet"/);
  assert.match(
    renderDesktopEntry(path.join(home, "LexiMeet App", "leximeet")),
    /Exec="[^"]*LexiMeet App[^"]*"/,
  );
  assert.equal(linuxAutostartEnabled({ homeDir: home }), true);
  setLinuxAutostart(false, { homeDir: home, executable });
  assert.equal(linuxAutostartEnabled({ homeDir: home }), false);
});
