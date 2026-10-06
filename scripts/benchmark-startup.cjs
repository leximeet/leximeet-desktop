const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { createHash } = require("node:crypto");

// 每次新 JVM；cold 使用新 SQLite，warm 复用预建的空测试库。不会清系统页缓存。
async function main() {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (
      !["--jar", "--manager", "--label", "--runs", "--output", "--monitor"].includes(
        process.argv[i],
      ) ||
      !process.argv[i + 1]
    )
      throw new Error("参数必须为 --jar/--manager/--label/--runs/--output/--monitor 的键值对");
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const root = path.resolve(__dirname, "..");
  const jar = path.resolve(options.jar || path.join(root, "core-java/target/leximeet-core.jar"));
  const { JavaRuntime } = require(
    path.resolve(options.manager || path.join(root, "electron/services/java-runtime.cjs")),
  );
  const runs = Number(options.runs || 8);
  if (!Number.isInteger(runs) || runs < 3 || runs > 30) throw new Error("runs 必须为 3–30");
  if (options.monitor && !["true", "false"].includes(options.monitor))
    throw new Error("monitor 必须为 true 或 false");
  const monitoring = options.monitor === "true";
  // 监控需要预先保存授权，因此开启模式只测已有空库，避免将默认关闭的首启冒充开启样本。
  const modes = monitoring ? ["warm-existing"] : ["cold-empty", "warm-existing"];
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-startup-benchmark-"));
  const rows = [];
  let active;
  try {
    active = new JavaRuntime({ jarPath: jar, dataDir: path.join(parent, "warm") });
    await active.start();
    await active.request("/api/snapshot");
    if (monitoring)
      await active.request("/api/settings", "PATCH", { developerMonitoringEnabled: true });
    await active.stop();
    active = null;
    for (const mode of modes) {
      for (let i = 0; i < runs; i++) {
        const dataDir =
          mode === "cold-empty" ? path.join(parent, `cold-${i}`) : path.join(parent, "warm");
        active = new JavaRuntime({ jarPath: jar, dataDir });
        const start = performance.now();
        await active.start();
        const ready = performance.now();
        await active.request("/api/snapshot");
        const first = performance.now();
        rows.push({
          mode,
          iteration: i + 1,
          readyMs: ready - start,
          firstSnapshotMs: first - start,
          firstRequestMs: first - ready,
        });
        await active.stop();
        active = null;
      }
    }
    const percentile = (values, p) =>
      [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b),
        middle = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
    };
    const summary = Object.fromEntries(
      modes.map((mode) => {
        const group = rows.filter((row) => row.mode === mode);
        return [
          mode,
          Object.fromEntries(
            ["readyMs", "firstSnapshotMs", "firstRequestMs"].map((key) => [
              key,
              {
                median: median(group.map((row) => row[key])),
                p95: percentile(
                  group.map((row) => row[key]),
                  0.95,
                ),
              },
            ]),
          ),
        ];
      }),
    );
    const report = {
      label: options.label || "current",
      monitoring,
      capturedAt: new Date().toISOString(),
      platform: `${process.platform}/${process.arch}`,
      node: process.version,
      javaHome: process.env.JAVA_HOME || null,
      jarSha256: createHash("sha256").update(fs.readFileSync(jar)).digest("hex"),
      runsPerScenario: runs,
      note:
        "新 JVM 进程冷启动；未清理 OS 页缓存。warm 在计时前已建空库并保存监控状态。" +
        (monitoring
          ? "本次监控开启，只测 warm，所有计时样本均已开启。"
          : "本次监控默认关闭，分别测新空库与当前格式已有空库。"),
      summary,
      rows,
    };
    const output = path.resolve(
      options.output || path.join(root, "test-results/startup-current.json"),
    );
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify({ output, summary }, null, 2));
  } finally {
    if (active) await active.stop();
    fs.rmSync(parent, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
