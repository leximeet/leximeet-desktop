const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const profile = process.argv[2] || "dev";
if (!fs.existsSync(path.join(root, "frontend/dist/index.html"))) {
  console.error("请先运行 npm run build，再运行 npm run dev / demo / start。");
  process.exit(1);
}
const env = { ...process.env, LEXIMEET_PROFILE: profile };
// 某些 IDE 会注入该变量；桌面启动必须运行 Electron 而非 Node 模式。
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require("electron"), [".", "--env=prod"], { cwd: root, env, stdio: "inherit" });
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code || 0;
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
