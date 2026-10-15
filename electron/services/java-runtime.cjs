const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const readline = require("node:readline");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { signalTree, pidAlive, signalOwnedByMarker } = require("./platform/process-tree.cjs");

const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const STARTUP_MESSAGES = Object.freeze({
  JAVA_RUNTIME_MISMATCH: "本机核心需要 Java 21，请使用完整应用的随包运行时",
  INVALID_STARTUP_OPTIONS: "启动参数无效，请使用应用提供的启动方式",
  UNSUPPORTED_DATA_SCHEMA: "资料格式不受当前版本支持；原文件已保留，请使用匹配的应用或新的隔离资料",
  DATA_STRUCTURE_MISMATCH: "资料结构不符合当前版本；原文件已保留，请使用有效备份或新的隔离资料",
  DATA_ACCESS_DENIED: "无法访问本机资料，请检查目录权限",
  DATA_DIRECTORY_INVALID: "本机资料位置不是可用目录，请选择独立资料目录",
  DATA_CORRUPTED: "资料文件无效或已损坏；原文件已保留，请从已验证的备份恢复",
  DATA_IN_USE: "本机资料正被另一应用使用，请关闭同一资料空间的另一应用后重试",
  STORAGE_FULL: "本机存储空间不足，请腾出空间后重试",
  INITIALIZATION_FAILED: "本机核心初始化失败，请检查安装包与资料版本；资料仍保存在本机",
});

// JVM 可能在 Main 前回显环境变量；不继承注入参数，也不向页面转发任意 stderr。
function coreEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]) delete result[key];
  return result;
}
const STARTUP_CODE_PATTERN = new RegExp(`\\[(${Object.keys(STARTUP_MESSAGES).join("|")})\\]`);

function startupFailure(stderr, exitCode) {
  const code =
    /Core 启动失败：\[([A-Z_]+)\]/.exec(stderr)?.[1] || STARTUP_CODE_PATTERN.exec(stderr)?.[1];
  const message = STARTUP_MESSAGES[code];
  return message
    ? `本机核心启动失败 [${code}]：${message}`
    : `本机核心无法启动（退出码 ${Number.isInteger(exitCode) ? exitCode : "未知"}）；请检查完整安装包，资料仍保存在本机`;
}

/** 管道在 Windows 上可能随 System.exit 被丢弃；文件句柄与 Core 自己的测试一致。 */
function attachStderr(child, { limit = 4000 } = {}) {
  let diagnostic = "";
  if (child.stderr) {
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk).slice(-limit);
    });
  }
  return () => diagnostic;
}

function readLogTail(file, limit = 4000) {
  try {
    const bytes = fs.readFileSync(file);
    if (!bytes.length) return "";
    const utf8 = bytes.toString("utf8");
    if (/Core 启动失败|DATA_IN_USE|\[[A-Z_]{4,}\]/.test(utf8)) return utf8.slice(-limit);
    const utf16 = bytes.toString("utf16le");
    if (/Core 启动失败|DATA_IN_USE|\[[A-Z_]{4,}\]/.test(utf16)) return utf16.slice(-limit);
    return utf8.slice(-limit);
  } catch {
    return "";
  }
}

/** Windows 必须用控制台子系统的 java.exe。javaw 会脱离父进程：stderr 丢失，stop 也杀不到 JVM。 */
function preferWindowlessJava(java, { platform = process.platform } = {}) {
  if (platform !== "win32" || typeof java !== "string") return java;
  return java.replace(/javaw(?=\.exe$|$)/i, "java");
}

function spawnJava(java, args, env, stderrFile) {
  const executable = preferWindowlessJava(java);
  const stderrFd = fs.openSync(stderrFile, "w", 0o600);
  const child = spawn(executable, args, {
    stdio: ["ignore", "pipe", stderrFd],
    // CREATE_NO_WINDOW + 重定向句柄，对齐 Core MainProcessTest 的文件 stderr。
    windowsHide: true,
    env,
  });
  fs.closeSync(stderrFd);
  return child;
}

function javaExecutable(env = process.env) {
  if (env.LEXIMEET_JAVA) return env.LEXIMEET_JAVA;
  if (env.JAVA_HOME)
    return path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
  return "java";
}

/** 产品等待 Core 写出端口的有界期限。Windows 首次启动会复制 Jar、拉起随包 JRE，Defender 实时扫描这些新文件。 */
function coreStartTimeoutMs(platform = process.platform) {
  return platform === "win32" ? 120000 : 45000;
}

// 主进程持有一次性令牌与动态端口；两者均不暴露给 renderer。
class JavaRuntime {
  constructor({
    jarPath,
    dataDir,
    demo = false,
    seedCapacity = 0,
    seedNoteLength = 0,
    java = javaExecutable(),
    timeout = 20000,
    profile = "local",
    testClockFile = "",
  }) {
    Object.assign(this, {
      jarPath,
      dataDir,
      demo,
      seedCapacity,
      seedNoteLength,
      java,
      timeout,
      profile,
      testClockFile,
    });
    this.token = null;
    this.port = null;
    this.child = null;
    this.starting = null;
    this.stopping = false;
    this.state = "stopped";
    this.instanceId = null;
    this.lastError = null;
    this.generation = 0;
  }
  // 并发调用复用同一个启动过程；已经健康运行时不会再创建第二个写入者。
  async start() {
    if (this.starting) return this.starting;
    if (this.port && this.child?.exitCode === null) return this;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } catch (error) {
      this.state = this.stopping && /取消/.test(error.message) ? "stopped" : "failed";
      this.lastError = error.message;
      throw error;
    } finally {
      this.starting = null;
    }
  }
  async startInternal() {
    this.state = "starting";
    this.lastError = null;
    this.generation++;
    if (!fs.existsSync(this.jarPath)) throw new Error("Java Core 尚未构建，请先运行 npm run build");
    // 业务时间推进仅属于显式隔离测试，认证、网络超时和电脑时间始终使用真实时间。
    if (this.testClockFile && (this.profile !== "test" || this.demo))
      throw new Error("业务测试时钟只能在隔离 test 环境使用");
    this.stopping = false;
    this.token = randomBytes(32).toString("hex");
    this.instanceId = randomBytes(8).toString("hex");
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    // JAR 类可能延迟加载；运行副本防止开发中重建原 JAR 破坏已启动进程。
    const runDir = fs.mkdtempSync(path.join(this.dataDir, "runtime-"));
    const runJar = path.join(runDir, "leximeet-core.jar");
    fs.copyFileSync(this.jarPath, runJar);
    const args = [
      "--enable-native-access=ALL-UNNAMED",
      "-Dfile.encoding=UTF-8",
      "-Dsun.stderr.encoding=UTF-8",
      "-Dsun.stdout.encoding=UTF-8",
      `-Dleximeet.instance=${this.instanceId}`,
      `-Djava.io.tmpdir=${runDir}`,
      "-jar",
      runJar,
      "--data-dir",
      this.dataDir,
      "--token",
      this.token,
    ];
    if (this.demo) args.push("--profile", "demo", "--seed-demo");
    else if (this.seedCapacity > 0) {
      args.push("--profile", "test", "--seed-capacity", String(this.seedCapacity));
      if (this.seedNoteLength > 0) args.push("--seed-note-length", String(this.seedNoteLength));
    }
    if (this.testClockFile) {
      if (!args.includes("--profile")) args.push("--profile", "test");
      args.push("--test-clock-file", this.testClockFile);
    }
    const stderrFile = path.join(runDir, "stderr.log");
    const child = spawnJava(this.java, args, coreEnvironment(), stderrFile);
    this.child = child;
    let diagnostic = "";
    const harvest = () => {
      const text = readLogTail(stderrFile);
      if (text) diagnostic = text;
      return diagnostic;
    };
    const cleanupState = () => {
      harvest();
      if (this.child === child) {
        this.port = null;
        this.state = this.stopping ? "stopped" : "failed";
        if (!this.stopping) this.lastError = "本地核心已停止，可以重启核心恢复；资料仍保存在本机";
      }
    };
    const removeRunDir = () => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 });
      } catch {
        // Windows 上刚退出的 javaw 可能短暂占用运行副本；诊断已经读走。
      }
    };
    child.once("exit", cleanupState);
    child.once("error", () => {
      cleanupState();
      removeRunDir();
    });
    try {
      await new Promise((resolve, reject) => {
        const lines = readline.createInterface({ input: child.stdout });
        let settled = false;
        const finish = (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          lines.close();
          if (error) reject(error);
          else resolve();
        };
        const timer = setTimeout(() => finish(new Error("Java Core 启动超时")), this.timeout);
        child.once("error", () =>
          finish(new Error("无法启动随包 Java 21，请检查完整安装包与执行权限")),
        );
        child.once("exit", (code) => {
          const report = (text) => {
            removeRunDir();
            finish(new Error(this.stopping ? "Java Core 启动已取消" : startupFailure(text, code)));
          };
          const text = harvest();
          if (this.stopping || STARTUP_CODE_PATTERN.test(text) || /Core 启动失败/.test(text)) {
            report(text);
            return;
          }
          // Windows 上 JVM 退出后文件刷新可能晚于 exit；短暂重试再分类。
          setTimeout(() => report(harvest()), 80);
        });
        lines.on("line", (line) => {
          let result;
          try {
            result = JSON.parse(line);
          } catch {
            return;
          }
          if (
            !Number.isInteger(result.port) ||
            result.port < 1 ||
            result.port > 65535 ||
            result.protocolVersion !== "1"
          )
            return;
          if (this.stopping) return finish(new Error("Java Core 启动已取消"));
          this.port = result.port;
          finish();
        });
      });
      const health = await this.request("/health");
      if (health.protocolVersion !== "1") throw new Error("本地核心协议版本不匹配");
      this.state = "ready";
      this.lastError = null;
      return this;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  async request(route, method = "GET", body) {
    if (!this.port || this.stopping) throw new Error("本地核心未连接，请重新启动词遇");
    if (!/^\/(health|api\/)/.test(route)) throw new Error("无效本地 API");
    const generation = this.generation;
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        // 一万词以上的完整备份在低配机器上需要独立预算，普通业务仍是 15 秒。
        signal: AbortSignal.timeout(requestBudget(route, body)),
        redirect: "error",
      });
    } catch (cause) {
      if (generation !== this.generation) throw new Error("本次请求所属核心已重启，请重试");
      if (cause?.name === "TimeoutError" || cause?.name === "AbortError") {
        const error = new Error("本次请求超时，执行结果尚未确认；请查询原操作回执");
        error.code = "DEADLINE_EXCEEDED";
        throw error;
      }
      this.state = "failed";
      this.lastError = "本地核心连接失败，可以重启核心后重试；资料仍保存在本机";
      throw new Error(this.lastError);
    }
    const result = await response.json();
    if (generation !== this.generation) throw new Error("本次请求所属核心已重启，请重试");
    if (!response.ok)
      throw new Error(
        result.error?.message ||
          result.error ||
          result.message ||
          `本地服务错误 ${response.status}`,
      );
    this.state = "ready";
    this.lastError = null;
    return result;
  }
  // 文件流只在 Main 与 Core 之间传递，不将大备份或本机路径交给 Renderer。
  async archiveResponse(route, method, body) {
    if (!this.port || this.stopping) throw new Error("本地核心未连接，请重新启动词遇");
    const generation = this.generation;
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.port}${route}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.token}`,
          ...(method === "POST" ? { "Content-Type": "application/vnd.sqlite3" } : {}),
        },
        body,
        ...(body ? { duplex: "half" } : {}),
        signal: AbortSignal.timeout(300000),
        redirect: "error",
      });
    } catch {
      if (generation !== this.generation) throw new Error("本次备份操作所属核心已重启，请重试");
      throw new Error("本机核心未完成文件传输，请检查连接后重试");
    }
    if (generation !== this.generation) throw new Error("本次备份操作所属核心已重启，请重试");
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error?.message || `本机核心拒绝文件备份（${response.status}）`);
    }
    return { response, generation };
  }
  async exportArchiveTo(destination) {
    const { response, generation } = await this.archiveResponse("/api/export-archive", "GET");
    if (response.headers.get("content-type") !== "application/vnd.sqlite3" || !response.body)
      throw new Error("本机核心返回了无效备份格式");
    const temporary = path.join(
      path.dirname(destination),
      `.leximeet-backup-${randomBytes(8).toString("hex")}.part`,
    );
    let bytes = 0;
    try {
      const bounded = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > MAX_ARCHIVE_BYTES ? new Error("文件备份超过 2 GiB") : null, chunk);
        },
      });
      await pipeline(
        Readable.fromWeb(response.body),
        bounded,
        fs.createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
      );
      if (generation !== this.generation) throw new Error("本次备份操作所属核心已重启，请重试");
      // 对话框已让用户选择目标；同目录更名避免出现部分写入的正式文件。
      fs.renameSync(temporary, destination);
      return { bytes };
    } catch (error) {
      if (error.message.includes("核心已重启") || error.message.includes("超过 2 GiB")) throw error;
      throw new Error("无法保存完整备份，请检查目标目录权限与可用空间");
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  async restoreArchiveFrom(file) {
    let stats;
    try {
      stats = fs.statSync(file);
    } catch {
      throw new Error("备份文件无法读取");
    }
    if (!stats.isFile() || stats.size > MAX_ARCHIVE_BYTES)
      throw new Error("备份文件不是普通文件或超过 2 GiB");
    const { response, generation } = await this.archiveResponse(
      "/api/restore-archive",
      "POST",
      fs.createReadStream(file),
    );
    const result = await response.json();
    if (generation !== this.generation) throw new Error("本次备份操作所属核心已重启，请重试");
    return result;
  }
  async stop() {
    this.stopping = true;
    // 未成功占住目录的启动失败（如 DATA_IN_USE）不得按资料目录回收，否则会误杀持锁原进程。
    const ownedDirectory = Boolean(this.port) || this.state === "ready";
    this.port = null;
    this.generation++;
    this.state = "stopped";
    const child = this.child;
    const pid = child?.pid;
    const detachStdio = () => {
      try {
        child?.stdout?.destroy();
      } catch {
        /* 拆掉管道，避免 Node 为已死或将死的子进程一直等 close */
      }
    };
    detachStdio();
    // Windows 上 Node 跟踪的 PID 可能对不上真正持锁的 java.exe，立刻 taskkill /T /F。
    // POSIX 留给后面的 2.5 秒 SIGTERM 宽限期，避免这里先 SIGKILL 让宽限失效。
    if (process.platform === "win32" && Number.isInteger(pid) && pidAlive(pid)) {
      try {
        signalTree(pid, "SIGKILL");
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }
    for (const marker of reclaimMarkers({
      instanceId: this.instanceId,
      dataDir: this.dataDir,
      ownedDirectory,
    })) {
      try {
        signalOwnedByMarker(marker);
      } catch {
        /* 按实例标记或资料目录回收失败时仍走下面的 PID 等待 */
      }
    }
    if (!child || !pid || child.exitCode !== null || child.signalCode !== null) {
      try {
        child?.unref();
      } catch {
        /* ignore */
      }
      return;
    }
    await new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        detachStdio();
        try {
          child.unref();
        } catch {
          /* 超时后放开句柄，避免测试进程被残留 JVM 拖住 */
        }
        clearTimeout(soft);
        clearTimeout(hard);
        resolve();
      };
      const killTree = () => {
        try {
          signalTree(child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      };
      // POSIX 先 SIGTERM；Windows 立刻 taskkill /T /F，避免 javaw 残留挂住测试进程。
      const soft = setTimeout(killTree, process.platform === "win32" ? 0 : 2500);
      const hard = setTimeout(done, 8000);
      child.once("exit", done);
      child.once("error", done);
      child.kill();
    });
  }
}
/** 只有成功占住资料目录的实例才按 --data-dir 回收，避免误杀同目录持锁进程。 */
function reclaimMarkers({ instanceId, dataDir, ownedDirectory }) {
  const markers = [];
  if (instanceId) markers.push(`leximeet.instance=${instanceId}`);
  if (ownedDirectory && dataDir) markers.push(dataDir);
  return markers;
}

// LMCP 查询与写入有不同的有界预算；超时不表示回滚，写入须查询原回执。
function requestBudget(route, body) {
  if (["/api/import", "/api/export", "/api/snapshot"].includes(route)) return 90000;
  if (route === "/api/mcp") return 15000;
  if (route !== "/api/lmcp/rpc") return 15000;
  const method = body?.envelope?.method;
  return ["recordEncounter", "openInDesktop"].includes(method) ? 15000 : 5000;
}
module.exports = {
  JavaRuntime,
  javaExecutable,
  requestBudget,
  reclaimMarkers,
  coreEnvironment,
  startupFailure,
  coreStartTimeoutMs,
  attachStderr,
  readLogTail,
  spawnJava,
  preferWindowlessJava,
};
