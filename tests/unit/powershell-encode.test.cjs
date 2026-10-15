"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { encodePowerShell } = require("../../electron/services/platform/powershell.cjs");

test("PowerShell EncodedCommand 是 UTF-16LE Base64，避免 -Command 再转义反斜杠", () => {
  const script = `$n = "C:\\\\tmp\\\\leximeet-core"; Get-CimInstance`;
  const encoded = encodePowerShell(script);
  assert.equal(Buffer.from(encoded, "base64").toString("utf16le"), script);
  assert.match(script, /;/);
});
