const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const { resolvePackageOutput } = require("./lib/package-output.cjs");

// 对固定构建结构做严格查找，多个候选视为歧义，避免误测旧安装包。
function findArtifact(kind, directory = resolvePackageOutput(root)) {
  const matches = [];
  function visit(dir, depth = 0) {
    if (!fs.existsSync(dir) || depth > 4) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const filename = path.join(dir, entry.name);
      if (
        kind === "executable" &&
        process.platform === "darwin" &&
        entry.isDirectory() &&
        entry.name === "LexiMeet.app"
      ) {
        matches.push(path.join(filename, "Contents/MacOS/LexiMeet"));
        continue;
      }
      if (
        kind === "executable" &&
        entry.isFile() &&
        ((process.platform === "win32" && entry.name === "LexiMeet.exe") ||
          (process.platform === "linux" && entry.name === "leximeet"))
      )
        matches.push(filename);
      if (
        kind === "installer" &&
        entry.isFile() &&
        (process.platform === "darwin"
          ? /\.dmg$/
          : process.platform === "win32"
            ? /\.exe$/
            : /\.AppImage$/
        ).test(entry.name)
      )
        matches.push(filename);
      // installer 只查分发文件，不把 unpacked 目录内的应用或卸载器误认成安装器。
      if (entry.isDirectory() && (kind !== "installer" || !/unpacked|\.app$/.test(entry.name)))
        visit(filename, depth + 1);
    }
  }
  visit(directory);
  const found = matches.filter((filename) => fs.existsSync(filename));
  if (found.length !== 1)
    throw new Error(
      `需要唯一 ${kind}，在 ${directory} 找到 ${found.length} 个；请显式设置对应 LEXIMEET_* 路径或使用干净的构建输出目录`,
    );
  return path.resolve(found[0]);
}
async function checksums(directory) {
  const names = fs
    .readdirSync(directory)
    .filter((name) => /\.(?:dmg|zip|exe|AppImage|tar\.gz)$/.test(name))
    .sort();
  if (!names.length) throw new Error("没有可计算校验和的分发产物");
  const lines = [];
  for (const name of names) {
    const hash = crypto.createHash("sha256");
    for await (const chunk of fs.createReadStream(path.join(directory, name))) hash.update(chunk);
    lines.push(`${hash.digest("hex")}  ${name}`);
  }
  fs.writeFileSync(path.join(directory, "SHA256SUMS"), lines.join("\n") + "\n");
}

// 目录内每个常规文件的相对路径与 SHA-256。清单本身不计入，符号链接直接拒绝。
function contentInventory(directory) {
  const files = [];
  function visit(dir) {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (entry.name === "SHA256SUMS" || entry.name === "CONTENT-SHA256.txt") continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`内容清单拒绝符号链接：${full}`);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        files.push(`${hash}  ${path.relative(directory, full).split(path.sep).join("/")}`);
      }
    }
  }
  visit(directory);
  const body = files.length ? `${files.join("\n")}\n` : "";
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  fs.writeFileSync(path.join(directory, "CONTENT-SHA256.txt"), `${body}# inventory ${digest}\n`);
  return { digest, count: files.length };
}
if (require.main === module) {
  const command = process.argv[2];
  Promise.resolve()
    .then(() => {
      if (command === "checksums")
        return checksums(
          process.argv[3] ? path.resolve(process.argv[3]) : resolvePackageOutput(root),
        );
      if (command === "inventory") {
        const result = contentInventory(
          process.argv[3] ? path.resolve(process.argv[3]) : resolvePackageOutput(root),
        );
        console.log(`${result.digest}  ${result.count}`);
        return;
      }
      if (!["find-executable", "find-installer"].includes(command))
        throw new Error("支持 find-executable / find-installer / checksums / inventory");
      console.log(findArtifact(command.slice(5), process.argv[3] && path.resolve(process.argv[3])));
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
module.exports = { findArtifact, checksums, contentInventory };
