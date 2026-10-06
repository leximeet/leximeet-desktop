const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

// jlink 只构建当前 OS/CPU 的运行时；安装包与 Java 运行时必须在同一原生 runner 构建。
function buildRuntime() {
  const javaHome = process.env.JAVA_HOME;
  if (!javaHome || !path.isAbsolute(javaHome))
    throw new Error("构建安装包需要 JAVA_HOME 指向本机 JDK 21 的绝对路径");
  const java = path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java");
  const sourceProbe = spawnSync(java, ["-XshowSettings:properties", "-version"], {
    encoding: "utf8",
    timeout: 10000,
  });
  if (
    sourceProbe.error ||
    sourceProbe.status !== 0 ||
    !/^\s*java.specification.version = 21\s*$/m.test(sourceProbe.stderr)
  ) {
    throw new Error("当前兼容发布单元固定 JDK 21；请勿使用 Java 17、25 或其他版本构建随包运行时");
  }
  const jlink = path.join(javaHome, "bin", process.platform === "win32" ? "jlink.exe" : "jlink");
  const output = path.join(root, ".runtime", "jre");
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, ".runtime", "jlink-"));
  const image = path.join(temporary, "runtime");
  try {
    const result = spawnSync(
      jlink,
      [
        // Spring Context 的 JavaBeans / 类装载支持与本机 JVM MXBean 纳入同一固定发布单元。
        // 不启用远程 JMX；java.management/jdk.management 仅供进程内读取数值。
        "--add-modules",
        "java.base,java.sql,java.net.http,jdk.httpserver,jdk.crypto.ec,jdk.unsupported,java.desktop,java.instrument,java.naming,java.management,jdk.management",
        "--strip-debug",
        "--no-header-files",
        "--no-man-pages",
        "--compress=2",
        "--output",
        image,
      ],
      { stdio: "inherit", timeout: 180000 },
    );
    if (result.error || result.status !== 0)
      throw result.error || new Error(`jlink 失败：${result.status}`);
    const release = fs.readFileSync(path.join(image, "release"), "utf8");
    // jlink 的 release 文件可能只保留版本与模块；从实际运行时读取架构。
    const probe = spawnSync(
      path.join(image, "bin", process.platform === "win32" ? "java.exe" : "java"),
      ["-XshowSettings:properties", "-version"],
      { encoding: "utf8" },
    );
    if (probe.error || probe.status !== 0)
      throw new Error("裁剪后的 Java 运行时无法在当前平台启动");
    const javaArch = /^\s*os.arch = (.+)$/m.exec(probe.stderr)?.[1].trim();
    const architecture = { aarch64: "arm64", amd64: "x64", x86_64: "x64", x86: "ia32" }[javaArch];
    if (architecture !== process.arch)
      throw new Error(`JDK 架构 ${javaArch} 与 Node/应用架构 ${process.arch} 不一致`);
    const javaMajor = Number(/^JAVA_VERSION="(\d+)/m.exec(release)?.[1]);
    if (javaMajor !== 21) throw new Error("安装包必须使用 Java 21 运行时");
    // legal/ 与 release 一并保留，方便许可证审查和构建来源追踪。
    fs.writeFileSync(
      path.join(image, "leximeet-runtime.json"),
      JSON.stringify(
        {
          platform: process.platform,
          arch: process.arch,
          javaVersion: /^JAVA_VERSION="([^"]+)"/m.exec(release)?.[1],
        },
        null,
        2,
      ) + "\n",
    );
    // 这里只替换脚本独占的构建输出，绝不清理用户资料或任意传入路径。
    fs.rmSync(output, { recursive: true, force: true });
    fs.renameSync(image, output);
    console.log(`已构建 ${process.platform}/${process.arch} Java 运行时：${output}`);
    return output;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) {
  fs.mkdirSync(path.join(root, ".runtime"), { recursive: true });
  try {
    buildRuntime();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
module.exports = { buildRuntime };
