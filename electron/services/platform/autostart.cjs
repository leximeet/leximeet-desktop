"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { xdgAutostartDir } = require("./app-paths.cjs");

const DESKTOP_NAME = "leximeet.desktop";

function autostartFile(options = {}) {
  return path.join(xdgAutostartDir(options), DESKTOP_NAME);
}

function renderDesktopEntry(executable) {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=LexiMeet",
    "Comment=词遇桌面",
    `Exec=${executable}`,
    "Terminal=false",
    "Categories=Education;",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n");
}

/** Linux 开机自启：尽力写入 XDG autostart，不宣称覆盖全部桌面环境。 */
function setLinuxAutostart(enabled, { homeDir, executable, env } = {}) {
  const file = autostartFile({ homeDir, env });
  if (!enabled) {
    fs.rmSync(file, { force: true });
    return { enabled: false, file };
  }
  if (!path.isAbsolute(executable || "")) throw new Error("AUTOSTART_EXECUTABLE_MUST_BE_ABSOLUTE");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, renderDesktopEntry(executable), { mode: 0o600 });
  return { enabled: fs.existsSync(file), file };
}

function linuxAutostartEnabled(options = {}) {
  return fs.existsSync(autostartFile(options));
}

module.exports = {
  DESKTOP_NAME,
  autostartFile,
  renderDesktopEntry,
  setLinuxAutostart,
  linuxAutostartEnabled,
};
