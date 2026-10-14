"use strict";
const { execFileSync } = require("node:child_process");

/** CI 挂起时打印本机进程表，便于区分 javaw/java/node 谁没退出。不按名称杀进程。 */
function dumpProcessTree(reason = "进程仍在运行", run = execFileSync) {
  console.error(`\n[进程树诊断] ${reason}`);
  try {
    if (process.platform === "win32") {
      run("tasklist", ["/V", "/FO", "TABLE"], {
        stdio: "inherit",
        windowsHide: true,
        timeout: 15000,
      });
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

module.exports = { dumpProcessTree };
