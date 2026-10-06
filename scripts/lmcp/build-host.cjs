"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

// 固定白名单物料外置，正式包不依赖 ASAR 或机器上另装 Node / JDK。
function buildNativeHost({
  projectDir = path.resolve(__dirname, "../.."),
  outputDir = path.join(projectDir, ".runtime", "lmcp-host"),
} = {}) {
  if (!path.isAbsolute(outputDir)) throw new Error("HOST_OUTPUT_MUST_BE_ABSOLUTE");
  const files = [
    ["electron/native-host/main.cjs", "host/main.cjs"],
    ["electron/services/lmcp/framing.cjs", "services/lmcp/framing.cjs"],
    ["electron/services/lmcp/private-files.cjs", "services/lmcp/private-files.cjs"],
  ];
  const hashes = [];
  for (const [source, target] of files) {
    const sourcePath = path.join(projectDir, source);
    const targetPath = path.join(outputDir, target);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true, mode: 0o700 });
    if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink())
      throw new Error("HOST_OUTPUT_SYMLINK_REJECTED");
    const bytes = fs.readFileSync(sourcePath);
    fs.writeFileSync(targetPath, bytes, { mode: 0o600 });
    hashes.push({ path: target, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const manifest = {
    format: "leximeet.native-host-bundle/1",
    runtime: "electron-run-as-node",
    entry: "host/main.cjs",
    files: hashes,
  };
  fs.writeFileSync(path.join(outputDir, "bundle.json"), JSON.stringify(manifest, null, 2) + "\n", {
    mode: 0o600,
  });
  return { outputDir, hostScript: path.join(outputDir, manifest.entry), files: hashes };
}
if (require.main === module)
  process.stdout.write(JSON.stringify(buildNativeHost(), null, 2) + "\n");
module.exports = { buildNativeHost };
