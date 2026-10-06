"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

// 同一只读事务观察真实私人 SQLite；不通过写库制造旅程结果。
function personalFacts(profileDir) {
  const file = path.join(profileDir, "core", "leximeet.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("BEGIN");
    const all = (sql) =>
      db
        .prepare(sql)
        .all()
        .map((row) => ({ ...row }));
    return {
      schemaVersion: db.prepare("PRAGMA user_version").get().user_version,
      words: all("SELECT id,word,note,created_at,updated_at,deleted_at FROM words ORDER BY id"),
      encounters: all(
        "SELECT id,word_id,context,source_title,source_url,created_at FROM encounters ORDER BY id",
      ),
      practice: all(
        "SELECT id,submission_id,word_id,mode,correct,created_at,signal,study_day,attempt_id,origin,undone_at FROM desktop_practice_facts ORDER BY length(logical_clock),logical_clock",
      ),
      reviews: all("SELECT * FROM desktop_reviews ORDER BY id"),
      books: all("SELECT * FROM books ORDER BY id"),
      wordBooks: all("SELECT * FROM word_books ORDER BY word_id,book_id"),
    };
  } finally {
    db.close();
  }
}

// 单独观察 LMCP 修订，避免把规划变更混进个人事实的相等比较。
function workspaceRevision(profileDir) {
  const db = new DatabaseSync(path.join(profileDir, "core", "leximeet.sqlite"), { readOnly: true });
  try {
    const revision = db.prepare("SELECT value FROM lmcp_meta WHERE key='revision'").get()?.value;
    if (revision === undefined)
      throw new Error("真实工作区尚未建立修订，不能验证回执恢复没有新写入");
    return revision;
  } finally {
    db.close();
  }
}

async function checksum(file) {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// 记录实际正在运行的应用及随包资源，不用源仓版本代替 app 版本。
async function applicationEvidence(desktop) {
  const info = await desktop.app.evaluate(({ app }) => ({
    packaged: app.isPackaged,
    version: app.getVersion(),
    resources: process.resourcesPath,
    executable: process.execPath,
  }));
  if (!info.packaged) throw new Error("升级验收必须使用两个真实应用包");
  return {
    ...info,
    appAsarSha256: await checksum(path.join(info.resources, "app.asar")),
    coreJarSha256: await checksum(path.join(info.resources, "core", "leximeet-core.jar")),
    nativeHostSha256: await checksum(path.join(info.resources, "native-host", "host", "main.cjs")),
  };
}

async function attachJson(info, name, value) {
  await info.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: "application/json",
  });
}

module.exports = { personalFacts, workspaceRevision, applicationEvidence, attachJson };
