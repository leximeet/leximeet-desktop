const fs = require("node:fs");
const path = require("node:path");

// 文件对话框与替换确认仅在 Main 执行；Renderer 只能请求命名动作。
class PortableBackupService {
  constructor({ core, dialog, profile, env = process.env }) {
    Object.assign(this, { core, dialog, profile, env });
  }

  testPath(variable, { existing }) {
    const chosen = this.env[variable];
    if (!chosen || !path.isAbsolute(chosen)) throw new Error("隔离验收没有提供私有备份文件路径");
    const root = fs.realpathSync(this.profile.root);
    const parent = fs.realpathSync(path.dirname(chosen));
    const relative = path.relative(root, parent);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error("隔离验收只能读写当前测试资料目录内的文件");
    if (existing) {
      if (
        !fs.existsSync(chosen) ||
        fs.lstatSync(chosen).isSymbolicLink() ||
        !fs.statSync(chosen).isFile()
      )
        throw new Error("隔离验收备份文件不存在或不是普通文件");
      const source = fs.realpathSync(chosen);
      const sourceRelative = path.relative(root, source);
      if (
        sourceRelative === ".." ||
        sourceRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(sourceRelative)
      )
        throw new Error("隔离验收只能读取当前测试资料目录内的文件");
    }
    return chosen;
  }

  async export() {
    const chosen =
      this.profile.name === "test"
        ? this.testPath("LEXIMEET_TEST_BACKUP_EXPORT", { existing: false })
        : (
            await this.dialog.showSaveDialog({
              title: "保存词遇完整备份",
              defaultPath: `leximeet-backup-${new Date().toISOString().slice(0, 10)}.sqlite`,
              filters: [{ name: "词遇 SQLite 备份", extensions: ["sqlite"] }],
            })
          ).filePath;
    if (!chosen) return { ok: true, action: "exportArchive", cancelled: true };
    const result = await this.core.exportArchiveTo(chosen);
    return {
      ok: true,
      action: "exportArchive",
      bytes: result.bytes,
      message: "完整备份已保存。文件含个人资料，请妥善保管。",
    };
  }

  async restore() {
    const chosen =
      this.profile.name === "test"
        ? this.testPath("LEXIMEET_TEST_BACKUP_IMPORT", { existing: true })
        : (
            await this.dialog.showOpenDialog({
              title: "选择词遇完整备份",
              properties: ["openFile"],
              filters: [{ name: "词遇 SQLite 备份", extensions: ["sqlite"] }],
            })
          ).filePaths?.[0];
    if (!chosen) return { ok: true, action: "restoreArchive", cancelled: true };
    const confirmed =
      this.profile.name === "test"
        ? this.env.LEXIMEET_TEST_BACKUP_CONFIRM === "1"
        : (
            await this.dialog.showMessageBox({
              type: "warning",
              title: "替换当前本机词库",
              message: "用所选备份替换当前词库、语境与学习记录？",
              detail:
                "恢复成功后，当前个人资料将由备份内容替换，设备隐私授权会关闭。请先保存当前资料的备份。",
              buttons: ["取消", "替换并恢复"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response === 1;
    if (!confirmed) return { ok: true, action: "restoreArchive", cancelled: true };
    const counts = await this.core.restoreArchiveFrom(chosen);
    return {
      ok: true,
      action: "restoreArchive",
      ...counts,
      message: "备份已恢复。剪贴板、快捷键与联网授权已关闭。",
    };
  }
}

module.exports = { PortableBackupService };
