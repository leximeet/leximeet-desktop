"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable, Writable } = require("node:stream");
const { PortableBackupService } = require("../../electron/services/portable-backup.cjs");
const { DesktopController } = require("../../electron/services/desktop-controller.cjs");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");

test("0.0.1 的导入导出开关关闭时不执行文件操作或打开对话框", async () => {
  let fileActions = 0;
  const desktop = new DesktopController({
    app: { isPackaged: false },
    profile: { name: "test" },
    fileBackupsEnabled: false,
    archive: {
      export() {
        fileActions++;
      },
      restore() {
        fileActions++;
      },
    },
  });
  assert.equal(desktop.capabilities().fileBackups.status, "unsupported");
  await assert.rejects(() => desktop.action({ action: "exportArchive" }), /后续版本开放/);
  await assert.rejects(() => desktop.action({ action: "restoreArchive" }), /后续版本开放/);
  assert.equal(fileActions, 0);
});

test("文件备份只能使用 Main 命名动作和隔离资料路径，恢复需要再次确认", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-archive-unit-"));
  const foreign = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-archive-foreign-"));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(foreign, { recursive: true, force: true });
  });
  const file = path.join(root, "backup.sqlite");
  const env = {
    LEXIMEET_TEST_BACKUP_EXPORT: file,
    LEXIMEET_TEST_BACKUP_IMPORT: file,
  };
  let exports = 0,
    restores = 0;
  const core = {
    async exportArchiveTo(destination) {
      exports++;
      fs.writeFileSync(destination, "test archive");
      return { bytes: 12 };
    },
    async restoreArchiveFrom(source) {
      restores++;
      assert.equal(source, file);
      return { restored: true, words: 1 };
    },
  };
  const archive = new PortableBackupService({
    core,
    dialog: {
      showSaveDialog() {
        throw new Error("隔离测试不应打开系统文件对话框");
      },
      showOpenDialog() {
        throw new Error("隔离测试不应打开系统文件对话框");
      },
      showMessageBox() {
        throw new Error("隔离测试不应打开系统确认框");
      },
    },
    profile: { name: "test", root },
    env,
  });
  const desktop = new DesktopController({
    app: { isPackaged: false },
    profile: { name: "test", root },
    archive,
  });
  await assert.rejects(
    () => desktop.action({ action: "restoreArchive", path: file }),
    /只接受命名 action/,
  );
  assert.equal((await desktop.action({ action: "exportArchive" })).bytes, 12);
  assert.equal(exports, 1);
  assert.equal((await desktop.action({ action: "restoreArchive" })).cancelled, true);
  assert.equal(restores, 0);
  env.LEXIMEET_TEST_BACKUP_CONFIRM = "1";
  assert.equal((await desktop.action({ action: "restoreArchive" })).words, 1);
  assert.equal(restores, 1);
  env.LEXIMEET_TEST_BACKUP_IMPORT = path.join(foreign, "outside.sqlite");
  fs.writeFileSync(env.LEXIMEET_TEST_BACKUP_IMPORT, "foreign");
  await assert.rejects(() => desktop.action({ action: "restoreArchive" }), /当前测试资料目录/);
  assert.equal(restores, 1);
});

test("正式资料的恢复确认默认取消，明确选择替换后才请求 Core", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-archive-dialog-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "selected.sqlite");
  fs.writeFileSync(file, "unit fixture");
  let response = 0,
    restores = 0,
    confirmation;
  const service = new PortableBackupService({
    profile: { name: "local", root },
    dialog: {
      async showOpenDialog() {
        return { filePaths: [file] };
      },
      async showMessageBox(options) {
        confirmation = options;
        return { response };
      },
    },
    core: {
      async restoreArchiveFrom(source) {
        assert.equal(source, file);
        restores++;
        return { restored: true };
      },
    },
  });
  assert.equal((await service.restore()).cancelled, true);
  assert.equal(restores, 0);
  assert.equal(confirmation.defaultId, 0);
  assert.equal(confirmation.cancelId, 0);
  assert.match(confirmation.detail, /设备隐私授权会关闭/);
  response = 1;
  assert.equal((await service.restore()).restored, true);
  assert.equal(restores, 1);
});

test("导出目标空间不足时保留旧备份并清理本次临时文件", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-archive-full-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "backup.sqlite");
  fs.writeFileSync(destination, "previous complete backup");
  const runtime = new JavaRuntime({ jarPath: "unused", dataDir: root });
  runtime.archiveResponse = async () => ({
    generation: runtime.generation,
    response: {
      headers: { get: () => "application/vnd.sqlite3" },
      body: Readable.toWeb(Readable.from([Buffer.from("SQLite format 3\0more data")])),
    },
  });
  // 仅替换本单测进程的文件流；不制造真实磁盘压力，也不影响其他测试资料。
  t.mock.method(fs, "createWriteStream", (file, options) => {
    fs.writeFileSync(file, "incomplete", {
      flag: options.flags,
      mode: options.mode,
    });
    return new Writable({
      write(_chunk, _encoding, done) {
        const error = new Error("simulated storage full");
        error.code = "ENOSPC";
        done(error);
      },
    });
  });
  await assert.rejects(() => runtime.exportArchiveTo(destination), /检查目标目录权限与可用空间/);
  assert.equal(fs.readFileSync(destination, "utf8"), "previous complete backup");
  assert.deepEqual(fs.readdirSync(root), ["backup.sqlite"]);
});
