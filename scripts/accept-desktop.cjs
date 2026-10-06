"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { createHash, randomUUID } = require("node:crypto");
const { hashFile } = require("../electron/services/text-dictionary-index.cjs");

const root = path.resolve(__dirname, "..");
const runtime = path.join(root, ".runtime");
const tools = path.join(runtime, "tools");
const args = process.argv.slice(2);

function run(command, values, options = {}) {
  const result = spawnSync(command, values, {
    cwd: root,
    stdio: "inherit",
    env: process.env,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw result.error || new Error(`命令未完成：${path.basename(command)}（${result.status}）`);
}
function installDependencies(npm) {
  const values = ["ci", "--ignore-scripts", "--no-audit", "--no-fund"];
  for (const proxy of [null, "http://127.0.0.1:7897", "http://127.0.0.1:12334"]) {
    const env = {
      ...process.env,
      ...(proxy
        ? {
            https_proxy: proxy,
            http_proxy: proxy,
            npm_config_proxy: proxy,
            npm_config_https_proxy: proxy,
          }
        : {}),
    };
    const result = spawnSync(npm, values, { cwd: root, env, stdio: "inherit" });
    if (!result.error && result.status === 0) return;
  }
  throw new Error("依赖准备失败，请检查网络或代理后重试");
}
function probe(command, values) {
  const result = spawnSync(command, values, {
    encoding: "utf8",
    timeout: 10000,
    env: process.env,
  });
  return result.status === 0 ? `${result.stdout || ""}\n${result.stderr || ""}` : "";
}
function download(url, output) {
  if (!url.startsWith("https://")) throw new Error("运行环境下载只接受 HTTPS");
  for (const proxy of [null, "http://127.0.0.1:7897", "http://127.0.0.1:12334"]) {
    const response = spawnSync(
      "curl",
      [
        "-fL",
        "--connect-timeout",
        "10",
        "--max-time",
        "300",
        ...(proxy ? ["--proxy", proxy] : []),
        url,
        "-o",
        output,
      ],
      { stdio: "inherit" },
    );
    if (!response.error && response.status === 0) return;
  }
  throw new Error("环境下载失败，请检查网络或代理；已有资料没有被修改");
}
function installedJavaHome() {
  const executable = process.platform === "win32" ? "java.exe" : "java";
  const managed = path.join(os.homedir(), "Library/PhpWebStudy/app");
  const candidates = [
    process.env.JAVA_HOME,
    path.join(tools, "jdk21"),
    process.platform === "darwin" ? probe("/usr/libexec/java_home", ["-v", "21"]).trim() : null,
  ];
  if (fs.existsSync(managed))
    for (const folder of fs.readdirSync(managed))
      if (folder.includes("openjdk-21"))
        candidates.push(path.join(managed, folder, "Contents/Home"));
  for (const home of candidates.filter(Boolean))
    if (
      /version "21[.\"]/.test(probe(path.join(home, "bin", executable), ["-version"])) &&
      ["javac", "jlink"].every((name) =>
        fs.existsSync(path.join(home, "bin", process.platform === "win32" ? `${name}.exe` : name)),
      )
    )
      return home;
  return null;
}
async function javaHome() {
  const installed = installedJavaHome();
  if (installed) return installed;
  const platform = { darwin: "mac", linux: "linux", win32: "windows" }[process.platform];
  const architecture = { arm64: "aarch64", x64: "x64" }[process.arch];
  if (!platform || !architecture || process.platform === "win32")
    throw new Error("请安装 JDK 21 并设置 JAVA_HOME；自动下载当前支持 macOS/Linux arm64/x64");
  console.log("正在准备项目内 Temurin JDK 21（保留官方许可证与校验信息）…");
  const metadata = path.join(tools, "jdk21-assets.json");
  download(
    `https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=${architecture}&image_type=jdk&os=${platform}&vendor=eclipse`,
    metadata,
  );
  const item = JSON.parse(fs.readFileSync(metadata))[0]?.binary?.package;
  if (
    !item ||
    !/^[a-f0-9]{64}$/.test(item.checksum) ||
    new URL(item.link).hostname !== "github.com"
  )
    throw new Error("JDK 官方发布信息无效");
  const archive = path.join(tools, "jdk21.tar.gz");
  download(item.link, archive);
  if ((await hashFile(archive)) !== item.checksum) throw new Error("JDK 下载校验失败");
  const stage = fs.mkdtempSync(path.join(tools, "jdk-install-"));
  run("tar", ["-xzf", archive, "-C", stage, "--strip-components=1"]);
  const extracted = process.platform === "darwin" ? path.join(stage, "Contents/Home") : stage;
  if (!/version "21[.\"]/.test(probe(path.join(extracted, "bin/java"), ["-version"])))
    throw new Error("下载的 JDK 无法在本机运行");
  const target = path.join(tools, "jdk21");
  if (fs.existsSync(target)) throw new Error("项目内 JDK 目录已存在，请检查后重试");
  fs.renameSync(extracted, target);
  return target;
}
async function maven() {
  let candidate = process.platform === "win32" ? "mvn.cmd" : "mvn";
  const local = path.join(os.homedir(), ".local/bin", candidate);
  if (/Apache Maven 3\.(?:9|[1-9]\d)\./.test(probe(candidate, ["-version"]))) return candidate;
  if (/Apache Maven 3\.9\./.test(probe(local, ["-version"]))) return local;
  const bundled = path.join(tools, "maven/bin/mvn");
  if (probe(bundled, ["-version"])) return bundled;
  console.log("正在准备项目内 Maven 3.9.11…");
  const url =
    "https://repo.maven.apache.org/maven2/org/apache/maven/apache-maven/3.9.11/apache-maven-3.9.11-bin.tar.gz";
  const archive = path.join(tools, "maven.tar.gz"),
    checksum = `${archive}.sha512`;
  download(url, archive);
  download(`${url}.sha512`, checksum);
  const expected = fs.readFileSync(checksum, "utf8").trim().split(/\s/)[0];
  const actual = createHash("sha512").update(fs.readFileSync(archive)).digest("hex");
  if (!/^[a-f0-9]{128}$/.test(expected) || expected !== actual)
    throw new Error("Maven 下载校验失败");
  const target = path.join(tools, "maven");
  fs.mkdirSync(target);
  run("tar", ["-xzf", archive, "-C", target, "--strip-components=1"]);
  return bundled;
}

async function prepare() {
  fs.mkdirSync(tools, { recursive: true });
  if (Number(process.versions.node.split(".")[0]) < 24)
    throw new Error("请通过 bash scripts/test-desktop.sh 启动，以自动准备 Node.js 24+");
  process.env.JAVA_HOME = await javaHome();
  process.env.LEXIMEET_JAVA = path.join(
    process.env.JAVA_HOME,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  const mvn = await maven();
  process.env.PATH = [
    path.join(process.env.JAVA_HOME, "bin"),
    path.dirname(mvn),
    path.dirname(process.execPath),
    process.env.PATH,
  ].join(path.delimiter);
  process.env.LEXIMEET_MAVEN = mvn;
  process.env.npm_config_cache = path.join(runtime, "npm-cache");
  process.env.NO_PROXY = [process.env.NO_PROXY, "localhost", "127.0.0.1", "::1"]
    .filter(Boolean)
    .join(",");
  process.env.no_proxy = process.env.NO_PROXY;
  const lock = createHash("sha256")
    .update(fs.readFileSync(path.join(root, "package-lock.json")))
    .digest("hex");
  const marker = path.join(runtime, "npm-ready.json");
  let ready = null;
  try {
    ready = JSON.parse(fs.readFileSync(marker));
  } catch {}
  const npm = path.join(
    path.dirname(process.execPath),
    process.platform === "win32" ? "npm.cmd" : "npm",
  );
  if (
    !fs.existsSync(path.join(root, "node_modules/vue/package.json")) ||
    ready?.lock !== lock ||
    ready?.node !== process.versions.node
  ) {
    installDependencies(npm);
    fs.writeFileSync(marker, JSON.stringify({ lock, node: process.versions.node }));
  }
  run(process.execPath, [path.join(__dirname, "install-electron.cjs")]);
  if (!fs.existsSync(path.join(root, "core-java/pom.xml")))
    throw new Error("缺少 Core 子模块，请先运行 git submodule update --init --recursive");
  run(process.execPath, [path.join(__dirname, "prepare-dictionary.cjs")]);
  // 每次从当前工作区增量构建，避免验收到旧 main 的前端或旧 Core。
  run(npm, ["run", "build:frontend"]);
  run(process.execPath, [path.join(__dirname, "java.cjs"), "package"]);
  console.log(
    `环境检查通过：Node ${process.versions.node} / JDK 21 / ${probe(mvn, ["-version"])
      .split("\n")[0]
      .replace(/\u001b\[[0-9;]*m/g, "")}`,
  );
  return {
    javaHome: process.env.JAVA_HOME,
    maven: mvn,
    node: process.execPath,
    nodeVersion: process.versions.node,
  };
}
async function main() {
  const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
  const single =
    args.length === 1 && ["--check", "--fresh", "--verify", "--help"].includes(args[0]);
  const resume = args.length === 2 && args[0] === "--resume" && uuid.test(args[1]) ? args[1] : null;
  if (args.length && !single && !resume)
    throw new Error("只支持 --check、--fresh、--verify 或 --resume <空间 ID>");
  if (args.includes("--help")) {
    console.log("bash scripts/test-desktop.sh [--check | --fresh | --verify | --resume <空间 ID>]");
    return;
  }
  if (args.includes("--verify")) return require("./verify-desktop.cjs").verify();
  if (args.includes("--check")) {
    // 只读诊断不复用 prepare()，缺工具也不下载、改缓存或编译。
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("需要 Node.js 24+");
    const home = installedJavaHome();
    if (!home) throw new Error("未找到完整 JDK 21；正常启动会自动准备，检查模式未修改环境");
    const mvn = [
      "mvn",
      path.join(os.homedir(), ".local/bin/mvn"),
      path.join(tools, "maven/bin/mvn"),
    ].find((file) => /Apache Maven 3\.(?:9|[1-9]\d)\./.test(probe(file, ["-version"])));
    if (!mvn) throw new Error("未找到 Maven 3.9+；正常启动会自动准备");
    for (const file of [
      "core-java/pom.xml",
      "node_modules/vue/package.json",
      "node_modules/electron/dist/version",
      "resources/dictionary/core-text.sqlite",
    ])
      if (!fs.existsSync(path.join(root, file)))
        throw new Error(`缺少 ${file}；正常启动会构建/准备`);
    const contract = require("./lmcp/verify-contract.cjs").verifyContract();
    console.log(
      JSON.stringify(
        {
          node: process.execPath,
          nodeVersion: process.versions.node,
          javaHome: home,
          maven: mvn,
          contract,
          readOnly: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  const environment = await prepare();
  const id = resume || randomUUID();
  const directory = path.join(runtime, "desktop-sessions", id);
  const infoFile = path.join(directory, "acceptance.json");
  if (resume && !fs.existsSync(infoFile)) throw new Error("找不到这个验收空间；没有创建或覆盖资料");
  if (resume) {
    const previous = JSON.parse(fs.readFileSync(infoFile));
    if (!previous.exitedAt && Number.isInteger(previous.pid)) {
      let alive = false;
      try {
        process.kill(previous.pid, 0);
        alive = true;
      } catch {}
      if (alive) throw new Error("这个验收应用仍在运行，请先从应用菜单退出，再继续同一空间");
    }
  }
  fs.mkdirSync(path.join(directory, "logs"), { recursive: true, mode: 0o700 });
  const logFile = path.join(directory, "logs", "launch.log");
  const log = fs.openSync(logFile, "a", 0o600);
  const env = {
    ...process.env,
    LEXIMEET_PROFILE: "demo",
    LEXIMEET_DATA_DIR: directory,
    LEXIMEET_SEED_DEMO: "0",
  };
  for (const key of [
    "ELECTRON_RUN_AS_NODE",
    "NODE_OPTIONS",
    "LEXIMEET_BACKGROUND_TEST",
    ...Object.keys(env).filter((key) => key.startsWith("LEXIMEET_TEST_")),
  ])
    delete env[key];
  let executable = require("electron"),
    launchArgs = [".", "--env=prod"];
  if (process.platform === "darwin") {
    // Electron 42+ 使用 UNNotification，需要有签名和稳定 bundle ID 的真实应用。
    // 验收应用与正式应用身份隔离，不借用通用 Electron 的通知权限。
    // 同一资料可反复验收，每次应用文件独占目录，避免覆写仍运行的 app。
    const output = path.join(directory, "applications", `${Date.now()}`);
    run(process.execPath, [path.join(__dirname, "package.cjs"), "dir"], {
      env: {
        ...process.env,
        LEXIMEET_BUILD_OUTPUT: output,
        LEXIMEET_ACCEPTANCE_APP: "1",
      },
    });
    executable = path.join(
      output,
      process.arch === "arm64" ? "mac-arm64" : "mac",
      "LexiMeet Acceptance.app/Contents/MacOS/LexiMeet Acceptance",
    );
    launchArgs = [];
  }
  const child = spawn(executable, launchArgs, {
    cwd: root,
    env,
    stdio: ["ignore", log, log],
  });
  const record = {
    id,
    profile: "demo",
    directory,
    environment,
    startedAt: new Date().toISOString(),
    pid: child.pid,
    logFile,
  };
  fs.writeFileSync(infoFile, JSON.stringify(record, null, 2), { mode: 0o600 });
  console.log(
    `已启动独立验收空间：${id}\n资料：${directory}\n日志：${logFile}\n下次继续：bash scripts/test-desktop.sh --resume ${id}\n新装引导：重新运行脚本即可创建全新空间。关闭窗口后可用菜单“退出词遇”完整退出。`,
  );
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    fs.closeSync(log);
    fs.writeFileSync(
      infoFile,
      JSON.stringify({ ...record, exitedAt: new Date().toISOString(), code, signal }, null, 2),
      { mode: 0o600 },
    );
    console.log("验收应用已退出，测试资料保留以便重启或核对备份。");
    process.exitCode = code || 0;
  });
}
module.exports = { prepare };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
