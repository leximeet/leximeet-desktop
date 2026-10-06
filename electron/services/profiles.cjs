const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");

// 正式库、开发库与一次性验收库从入口处分离；绝不清理用户已有目录。
function resolveProfile({ name = "local", dataDir, projectDir, userData }) {
  if (!["local", "dev", "demo", "test", "preview"].includes(name)) throw new Error("未知运行环境");
  const ephemeral = ["demo", "test", "preview"].includes(name);
  if (dataDir && !path.isAbsolute(dataDir)) throw new Error("LEXIMEET_DATA_DIR 必须是绝对路径");
  const root =
    dataDir ||
    (ephemeral
      ? fs.mkdtempSync(path.join(os.tmpdir(), `leximeet-${name}-`))
      : name === "dev"
        ? path.join(projectDir, ".runtime", "dev-v1")
        : userData && path.join(userData, "workspaces", "v1"));
  if (!root) throw new Error("缺少本机数据目录");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const marker = path.join(root, "profile.json");
  if (fs.existsSync(marker)) {
    const stored = JSON.parse(fs.readFileSync(marker, "utf8"));
    if (stored.profile !== name)
      throw new Error(`此目录属于 ${stored.profile} 环境，拒绝以 ${name} 打开`);
  } else
    fs.writeFileSync(
      marker,
      JSON.stringify({ profile: name, createdAt: new Date().toISOString() }),
      { mode: 0o600 },
    );
  for (const child of ["core", "chromium", "logs"])
    fs.mkdirSync(path.join(root, child), { recursive: true, mode: 0o700 });
  return {
    name,
    root,
    coreDir: path.join(root, "core"),
    sessionDir: path.join(root, "chromium"),
    ephemeral,
  };
}
module.exports = { resolveProfile };
