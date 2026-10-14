const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// Maven 仓库也隔离在项目运行目录，避免测试改动其他工程缓存配置。
const root = path.resolve(__dirname, "..");

/** Windows 冷启动 + Defender 扫描时，第一次 mvn -version 可能超过 10 秒。 */
function probeMavenJava({
  spawn = spawnSync,
  env = process.env,
  platform = process.platform,
} = {}) {
  const timeout = platform === "win32" ? 30000 : 10000;
  const attempts = platform === "win32" ? 3 : 1;
  const executable = env.LEXIMEET_MAVEN || "mvn";
  let last = "";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const probe = spawn(
      platform === "win32" ? "mvn.cmd -version" : executable,
      platform === "win32" ? [] : ["-version"],
      {
        encoding: "utf8",
        env,
        shell: platform === "win32",
        timeout,
      },
    );
    const information = `${probe.stdout || ""}\n${probe.stderr || ""}`.replace(
      /\u001b\[[0-9;]*m/g,
      "",
    );
    last = information.trim() || probe.error?.message || `status=${probe.status}`;
    if (!probe.error && probe.status === 0 && /Java version:\s*21(?:[.,\s]|$)/.test(information))
      return information;
  }
  throw new Error(
    `需要 JDK 21 与 Maven 3.9+；请把 JAVA_HOME / IDEA Maven Runner JRE 设置为 21。\n${last}`,
  );
}

function runMaven(goal = "test") {
  if (!fs.existsSync(path.join(root, "core-java/pom.xml")))
    throw new Error("Core 子模块未初始化：请运行 git submodule update --init --recursive");
  if (!["test", "package", "benchmark-index"].includes(goal))
    throw new Error("只支持 test / package / benchmark-index");
  const benchmarkOutput = path.join(root, "test-results", "performance", "lmcp-index-50000.json");
  const args = [
    "-B",
    "-ntp",
    "-gs",
    path.join(root, "core-java", "maven-settings.xml"),
    "-s",
    path.join(root, "core-java", "maven-settings.xml"),
    `-Dmaven.repo.local=${path.join(root, ".runtime", "m2")}`,
    // Boot repackage 会替换原 jar；强制生成普通 jar 后再包装，避免重复包装旧产物。
    ...(goal === "package"
      ? ["-DskipTests", "-Dmaven.jar.forceCreation=true"]
      : goal === "test"
        ? ["clean"]
        : []),
    ...(goal === "benchmark-index"
      ? [
          "-Dtest=IndexSnapshotBenchmark",
          `-Dleximeet.benchmark.output=${benchmarkOutput}`,
          "-Dleximeet.benchmark.verify=true",
        ]
      : []),
    goal === "benchmark-index" ? "test" : goal,
  ];
  // Windows 的 .cmd 必须经命令解释器运行；先拒绝解释器元字符，再完整引用各参数。
  // 使用相对 Maven 项目路径不够：仓库和设置路径都允许包含中文与空格。
  if (process.platform === "win32" && args.some((value) => /["%!?&|<>^\r\n]/.test(value)))
    throw new Error("Maven 路径包含 Windows shell 元字符，请换到普通工作目录");
  const executable = process.env.LEXIMEET_MAVEN || "mvn";
  const command =
    process.platform === "win32"
      ? `mvn.cmd ${args.map((value) => `"${value}"`).join(" ")}`
      : executable;
  // 验证实际 Maven Runner 的 JDK，而非只相信 JAVA_HOME 字符串或系统 java。
  // pom.xml 的 Enforcer 同时保护 IDEA 与直接 mvn 入口，版本约束不可只放在 npm 脚本里。
  probeMavenJava();
  const result = spawnSync(command, process.platform === "win32" ? [] : args, {
    cwd: path.join(root, "core-java"),
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) console.error("需要 JDK 21 与 Maven 3.9+：", result.error.message);
  if (!result.error && result.status === 0 && goal === "benchmark-index") {
    const report = JSON.parse(fs.readFileSync(benchmarkOutput, "utf8"));
    const cold = report.measurements.coldFullSnapshot;
    const warm = report.measurements.warmFullSnapshot;
    console.log(
      `LMCP 索引基准：冷 ${cold.elapsedMs} ms，热 ${warm.elapsedMs} ms，${cold.items} 词 / ${cold.pages} 页。`,
    );
    console.log(`基准报告：${benchmarkOutput}`);
  }
  return result.status ?? 1;
}

if (require.main === module) {
  try {
    process.exit(runMaven(process.argv[2] || "test"));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { probeMavenJava, runMaven };
