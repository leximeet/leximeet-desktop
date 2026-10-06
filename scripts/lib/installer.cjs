const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function assertInstaller(filename, platform = process.platform, env = process.env) {
  if (!filename || !path.isAbsolute(filename) || !fs.statSync(filename).isFile())
    throw new Error("安装产物必须是现有文件的绝对路径");
  const suffix = { darwin: /\.dmg$/, win32: /\.exe$/, linux: /\.AppImage$/ }[platform];
  if (!suffix?.test(filename)) throw new Error("安装产物类型与当前操作系统不符");
  // NSIS 会改写当前用户注册表、快捷方式，临时 /D 目录并不能隔离这些副作用。
  if (
    platform === "win32" &&
    !(env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted") &&
    env.LEXIMEET_DISPOSABLE_MACHINE !== "1"
  ) {
    throw new Error(
      "Windows 安装测试仅允许 GitHub 托管 runner 或一次性 Windows VM；在 VM 内显式设置 LEXIMEET_DISPOSABLE_MACHINE=1",
    );
  }
}

function createInstallation() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-install-"));
  const target = path.join(root, "LexiMeet Test Application");
  const events = [];
  let mounted;
  let windowsInstallAttempted = false;
  function run(command, args, options = {}) {
    const result = spawnSync(command, args, {
      encoding: "utf8",
      timeout: 180000,
      windowsHide: true,
      ...options,
    });
    events.push({
      command: path.basename(command),
      args,
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    });
    if (result.error || result.status !== 0)
      throw (
        result.error ||
        new Error(`${path.basename(command)} 返回 ${result.status}: ${result.stderr || ""}`)
      );
    return result;
  }
  function removeOwnTarget() {
    fs.rmSync(target, { recursive: true, force: true });
  }
  function install(filename) {
    assertInstaller(filename);
    if (process.platform === "darwin") {
      const mountpoint = path.join(root, "mount");
      fs.mkdirSync(mountpoint, { recursive: true });
      run("/usr/bin/hdiutil", [
        "attach",
        filename,
        "-readonly",
        "-nobrowse",
        "-mountpoint",
        mountpoint,
      ]);
      mounted = mountpoint;
      try {
        const app = path.join(mounted, "LexiMeet.app");
        if (!fs.existsSync(app)) throw new Error("DMG 中缺少 LexiMeet.app");
        removeOwnTarget();
        fs.mkdirSync(target);
        run("/usr/bin/ditto", [app, path.join(target, "LexiMeet.app")]);
      } finally {
        run("/usr/bin/hdiutil", ["detach", mounted]);
        mounted = undefined;
      }
    } else if (process.platform === "linux") {
      // 验证 AppImage 内的可分发 payload；不声称覆盖 FUSE 桌面集成。
      const extraction = fs.mkdtempSync(path.join(root, "extract-"));
      const image = path.join(extraction, "candidate.AppImage");
      fs.copyFileSync(filename, image);
      fs.chmodSync(image, 0o755);
      run(image, ["--appimage-extract"], { cwd: extraction });
      removeOwnTarget();
      fs.renameSync(path.join(extraction, "squashfs-root"), target);
    } else {
      fs.mkdirSync(target, { recursive: true });
      // /D 必须最后出现，NSIS 自行解析余下的完整路径（包含空格）。
      windowsInstallAttempted = true;
      run(filename, ["/S", "/currentuser", `/D=${target}`], { windowsVerbatimArguments: true });
    }
    const executable =
      process.platform === "darwin"
        ? path.join(target, "LexiMeet.app/Contents/MacOS/LexiMeet")
        : path.join(target, process.platform === "win32" ? "LexiMeet.exe" : "leximeet");
    if (!fs.existsSync(executable)) throw new Error(`安装完成但缺少可执行文件：${executable}`);
    return executable;
  }
  function cleanup() {
    if (mounted) {
      run("/usr/bin/hdiutil", ["detach", mounted]);
      mounted = undefined;
    }
    if (process.platform === "win32" && windowsInstallAttempted) {
      const uninstaller = path.join(target, "Uninstall LexiMeet.exe");
      // 部分安装也可能已写注册表；必须尝试卸载。清理失败保留目录并明确失败，不能伪装成功。
      if (!fs.existsSync(uninstaller))
        throw new Error(`安装尝试后缺少卸载器，保留 ${root}；请销毁一次性 VM`);
      run(uninstaller, ["/S", "/currentuser", `_?=${target}`], { windowsVerbatimArguments: true });
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  return { root, install, cleanup, events };
}
module.exports = { createInstallation, assertInstaller };
