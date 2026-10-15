"use strict";
const { execFileSync } = require("node:child_process");

/** Windows 用 CIM，才能带上父进程 PID；tasklist /V 没有 PPID。 */
const WINDOWS_PROCESS_TREE_SCRIPT =
  "Get-CimInstance -ClassName Win32_Process | Select-Object ProcessId,ParentProcessId,Name | Format-Table -AutoSize | Out-String -Width 240";

/** CI 挂起时打印本机进程表，便于区分 javaw/java/node 谁没退出。不按名称杀进程。 */
function dumpProcessTree(reason = "进程仍在运行", run = execFileSync) {
  console.error(`\n[进程树诊断] ${reason}`);
  try {
    if (process.platform === "win32") {
      const { encodePowerShell } = require("../../electron/services/platform/powershell.cjs");
      const { windowsSystem32Binary } = require("../../electron/services/platform/identity.cjs");
      run(
        windowsSystem32Binary("powershell.exe"),
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodePowerShell(
            `$ProgressPreference = 'SilentlyContinue'; ${WINDOWS_PROCESS_TREE_SCRIPT}`,
          ),
        ],
        { stdio: "inherit", windowsHide: true, timeout: 15000 },
      );
      return;
    }
    run("ps", ["-ax", "-o", "pid,ppid,stat,etime,command"], {
      stdio: "inherit",
      timeout: 10000,
    });
  } catch (error) {
    console.error(`无法打印进程树：${error.message}`);
  }
}

module.exports = { dumpProcessTree, WINDOWS_PROCESS_TREE_SCRIPT };
