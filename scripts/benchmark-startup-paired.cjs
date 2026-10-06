const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createHash } = require("node:crypto");
const { performance } = require("node:perf_hooks");

// 偶数样本中位数取中间两数平均；小样本 p95 使用 nearest-rank，8 次时等于最大值。
function statistics(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    count: sorted.length,
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    min: sorted[0],
    max: sorted.at(-1),
  };
}
const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const root = path.resolve(__dirname, "..");
  const options = {};
  const allowed = [
    "pairs",
    "output",
    "java",
    "before-jar",
    "before-manager",
    "after-jar",
    "after-manager",
  ];
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i].replace(/^--/, "");
    if (!allowed.includes(key) || !process.argv[i + 1])
      throw new Error(`无效参数：${process.argv[i]}`);
    options[key] = process.argv[i + 1];
  }
  const pairs = Number(options.pairs || 8);
  if (!Number.isInteger(pairs) || pairs < 8 || pairs > 50) throw new Error("pairs 必须为 8–50");
  const java =
    options.java || (process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin/java"));
  if (!java || !fs.existsSync(java))
    throw new Error("请用 --java 明确指定 JDK 21 的 java 可执行文件");
  for (const name of ["JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS"]) {
    if (process.env[name]) throw new Error(`请先取消 ${name}，避免未记录的 JVM 参数影响测量`);
  }
  const javaVersion = spawnSync(java, ["-version"], { encoding: "utf8" });
  if (javaVersion.status !== 0) throw new Error("无法读取 Java 版本");
  const versionText = `${javaVersion.stdout}${javaVersion.stderr}`.trim();
  if (!/version "21[."]/.test(versionText)) throw new Error(`本测量要求 JDK 21：${versionText}`);

  const sources = {
    before: {
      jar: path.resolve(
        options["before-jar"] || path.join(root, ".runtime/pre-boot/leximeet-core.jar"),
      ),
      manager: path.resolve(
        options["before-manager"] || path.join(root, ".runtime/pre-boot/java-runtime.cjs"),
      ),
    },
    after: {
      jar: path.resolve(
        options["after-jar"] || path.join(root, "core-java/target/leximeet-core.jar"),
      ),
      manager: path.resolve(
        options["after-manager"] || path.join(root, "electron/services/java-runtime.cjs"),
      ),
    },
  };
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-startup-paired-"));
  const output = path.resolve(
    options.output || path.join(root, "test-results/startup-paired.json"),
  );
  const fixtures = {};
  const artifacts = {};
  let active;
  const startedAt = new Date().toISOString();
  const report = {
    status: "running",
    startedAt,
    environment: {
      platform: `${process.platform}/${process.arch}`,
      osRelease: os.release(),
      osVersion: os.version(),
      cpu: os.cpus()[0]?.model,
      logicalCpus: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      node: process.version,
      javaExecutable: java,
      javaVersion: versionText,
      jvmFlags: [
        "--enable-native-access=ALL-UNNAMED",
        "-Dfile.encoding=UTF-8",
        "-Djava.io.tmpdir=<isolated-runtime>",
        "-jar <isolated-copy>",
      ],
    },
    artifacts,
    pairsPerScenario: pairs,
    preparation: [],
    rows: [],
    pairs: [],
    summary: {},
    method:
      "每个样本为新 JVM；相邻配对 AB/BA 交替；每轮轮转三场景次序；已有空库计时前预建，默认关闭及预先开启分别建库。计时包含运行 JAR 副本复制、JVM 启动、ready 握手、health、首次 snapshot，不包括预建/停止/诊断轮询。未清 OS 页缓存；每次停止后等待 150ms。",
  };
  function save() {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  }
  try {
    // 在计时前冻结两套产物，避免其他构建改变后续样本的 JAR 或管理器。
    for (const [label, source] of Object.entries(sources)) {
      artifacts[label] = {
        sourceJar: source.jar,
        jarSha256: sha256(source.jar),
        jarBytes: fs.statSync(source.jar).size,
        sourceManager: source.manager,
        managerSha256: sha256(source.manager),
      };
      const jar = path.join(sandbox, `${label}.jar`);
      const manager = path.join(sandbox, `${label}.cjs`);
      fs.copyFileSync(source.jar, jar);
      fs.copyFileSync(source.manager, manager);
      fixtures[label] = { jar, Runtime: require(manager).JavaRuntime };
    }
    async function prepare(key, variant, monitoring) {
      const dataDir = path.join(sandbox, key);
      const fixture = fixtures[variant];
      active = new fixture.Runtime({ jarPath: fixture.jar, dataDir, java });
      await active.start();
      let snapshot = await active.request("/api/snapshot");
      if (variant === "after")
        snapshot = await active.request("/api/settings", "PATCH", {
          developerMonitoringEnabled: monitoring,
        });
      if (
        snapshot.words.length ||
        Boolean(snapshot.settings.developerMonitoringEnabled) !== monitoring
      )
        throw new Error("预建空库或监控设置不符合场景");
      await active.stop();
      active = null;
      report.preparation.push({ key, variant, monitoring, excludedFromTiming: true });
      return dataDir;
    }
    const beforeExisting = await prepare("before-existing", "before", false);
    const afterExistingOff = await prepare("after-existing-off", "after", false);
    const afterExistingOn = await prepare("after-existing-on", "after", true);
    const scenarios = [
      {
        name: "new-empty-default-off",
        left: { variant: "before", monitoring: false },
        right: { variant: "after", monitoring: false },
      },
      {
        name: "existing-empty-default-off",
        left: { variant: "before", monitoring: false, dataDir: beforeExisting },
        right: { variant: "after", monitoring: false, dataDir: afterExistingOff },
      },
      {
        name: "existing-empty-monitor-off-on",
        left: { variant: "after", monitoring: false, dataDir: afterExistingOff },
        right: { variant: "after", monitoring: true, dataDir: afterExistingOn },
      },
    ];
    for (let round = 0; round < pairs; round++) {
      const sequence = [
        ...scenarios.slice(round % scenarios.length),
        ...scenarios.slice(0, round % scenarios.length),
      ];
      for (const scenario of sequence) {
        const order = round % 2 ? ["right", "left"] : ["left", "right"];
        const pairRows = {};
        for (const side of order) {
          const option = scenario[side],
            fixture = fixtures[option.variant];
          const dataDir = option.dataDir || path.join(sandbox, `fresh-${round}-${side}`);
          active = new fixture.Runtime({ jarPath: fixture.jar, dataDir, java });
          const capturedAt = new Date().toISOString(),
            loadAverageBefore = os.loadavg();
          const start = performance.now();
          await active.start();
          const ready = performance.now();
          const snapshot = await active.request("/api/snapshot");
          const first = performance.now();
          if (
            snapshot.words.length ||
            Boolean(snapshot.settings.developerMonitoringEnabled) !== option.monitoring
          )
            throw new Error("计时样本的领域状态不符合场景");
          const row = {
            scenario: scenario.name,
            pair: round + 1,
            order: order.join("-"),
            side,
            variant: option.variant,
            monitoring: option.monitoring,
            capturedAt,
            loadAverageBefore,
            readyMs: ready - start,
            firstSnapshotMs: first - start,
            firstRequestMs: first - ready,
          };
          report.rows.push(row);
          pairRows[side] = row;
          await active.stop();
          active = null;
          await pause(150);
        }
        report.pairs.push({
          scenario: scenario.name,
          pair: round + 1,
          order: order.join("-"),
          leftMs: pairRows.left.firstSnapshotMs,
          rightMs: pairRows.right.firstSnapshotMs,
          deltaMs: pairRows.right.firstSnapshotMs - pairRows.left.firstSnapshotMs,
          deltaPercent: (pairRows.right.firstSnapshotMs / pairRows.left.firstSnapshotMs - 1) * 100,
        });
        save();
      }
      console.log(`配对轮次 ${round + 1}/${pairs} 完成（累计 ${report.rows.length} 个计时启动）`);
    }
    for (const scenario of scenarios) {
      const rows = report.rows.filter((row) => row.scenario === scenario.name);
      report.summary[scenario.name] = Object.fromEntries(
        ["left", "right"].map((side) => [
          side,
          Object.fromEntries(
            ["readyMs", "firstSnapshotMs", "firstRequestMs"].map((key) => [
              key,
              statistics(rows.filter((row) => row.side === side).map((row) => row[key])),
            ]),
          ),
        ]),
      );
      const paired = report.pairs.filter((pair) => pair.scenario === scenario.name);
      report.summary[scenario.name].pairedDeltaMs = statistics(paired.map((pair) => pair.deltaMs));
      report.summary[scenario.name].pairedDeltaPercent = statistics(
        paired.map((pair) => pair.deltaPercent),
      );
    }
    report.status = "complete";
    report.finishedAt = new Date().toISOString();
    save();
    console.log(JSON.stringify({ output, summary: report.summary }, null, 2));
  } catch (error) {
    report.status = "failed";
    report.error = error.message;
    save();
    throw error;
  } finally {
    if (active) await active.stop();
    // 只删除本脚本 mkdtemp 创建的测量沙箱，从不使用正式 profile。
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
