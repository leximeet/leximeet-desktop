"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const source = path.join(root, "resources", "native", "leximeet-run-as-node.c");
const output = path.join(root, "resources", "native", "leximeet-run-as-node.exe");

function exists(file) {
  return Boolean(file) && fs.existsSync(file);
}

function vcvarsCandidates() {
  const install = process.env.VSINSTALLDIR;
  return [
    install && path.join(install, "VC", "Auxiliary", "Build", "vcvars64.bat"),
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Auxiliary\\Build\\vcvars64.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Professional\\VC\\Auxiliary\\Build\\vcvars64.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvars64.bat",
    "C:\\Program Files\\Microsoft Visual Studio\\2022\\BuildTools\\VC\\Auxiliary\\Build\\vcvars64.bat",
  ].filter(Boolean);
}

function compileWithVcvars() {
  const vcvars = vcvarsCandidates().find(exists);
  if (!vcvars) return null;
  const script = `call "${vcvars}" && cl /nologo /O2 /Fe"${output}" "${source}" /link advapi32.lib shell32.lib`;
  return spawnSync("cmd.exe", ["/d", "/s", "/c", script], { stdio: "inherit", windowsHide: true });
}

function compilers() {
  if (process.platform === "win32") {
    return [{ cmd: "gcc", args: ["-O2", "-s", "-o", output, source, "-ladvapi32", "-lshell32"] }];
  }
  return [
    {
      cmd: "x86_64-w64-mingw32-gcc",
      args: ["-O2", "-s", "-o", output, source, "-ladvapi32", "-lshell32"],
    },
    { cmd: "mingw32-gcc", args: ["-O2", "-s", "-o", output, source, "-ladvapi32", "-lshell32"] },
  ];
}

function build({ required = process.platform === "win32" } = {}) {
  if (!fs.existsSync(source)) throw new Error("缺少 leximeet-run-as-node.c");
  if (process.platform === "win32") {
    const msvc = compileWithVcvars();
    if (
      msvc &&
      !msvc.error &&
      msvc.status === 0 &&
      exists(output) &&
      fs.statSync(output).size >= 1024
    )
      return output;
    if (msvc && (msvc.error || msvc.status !== 0))
      console.warn("MSVC 编译 PE stub 未成功，尝试 MinGW。");
  }
  for (const compiler of compilers()) {
    const probe = spawnSync(compiler.cmd, ["--version"], { encoding: "utf8" });
    if (probe.error || probe.status !== 0) continue;
    const result = spawnSync(compiler.cmd, compiler.args, { stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw result.error || new Error(`${compiler.cmd} 编译 PE stub 失败`);
    if (!exists(output) || fs.statSync(output).size < 1024) throw new Error("PE stub 产物无效");
    return output;
  }
  if (required) throw new Error("Windows 需要 MSVC 或 MinGW 以编译 leximeet-run-as-node.exe");
  return exists(output) ? output : "";
}

if (require.main === module) {
  try {
    const file = build({ required: process.argv.includes("--required") });
    console.log(file ? `PE stub：${file}` : "当前环境未编译 PE stub（非 Windows 可跳过）");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { build };
