"use strict";
const { execFileSync } = require("node:child_process");

/** 用 EncodedCommand 避免 powershell -Command 再吃一层反斜杠。 */
function encodePowerShell(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

function runPowerShell(script, { timeout = 15000 } = {}) {
  return execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShell(`$ProgressPreference = 'SilentlyContinue'; ${script}`),
    ],
    { encoding: "utf8", windowsHide: true, timeout },
  );
}

module.exports = { encodePowerShell, runPowerShell };
