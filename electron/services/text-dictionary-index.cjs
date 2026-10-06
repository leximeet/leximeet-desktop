"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { StringDecoder } = require("node:string_decoder");

// 显式保留 UTF-8 与长行的块边界；大正文通过有界分块解析，避免中文或长行在边界被截断。
async function* jsonLines(stream) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.write(chunk);
    let newline;
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line) yield line;
    }
    if (Buffer.byteLength(pending) > 1_000_000) throw new Error("词典词条超过允许大小");
  }
  pending += decoder.end();
  if (pending.trim()) yield pending;
}

const MANIFEST_SHA = "8c9392ddf92c3bf3b0f471075b55c5042826a08129c4aa1efbbe9cd922926317";
const RELEASE_URL = "https://github.com/leximeet/leximeet-dictionary/releases/download/v0.0.3/";
// 公共资源索引独立于私人数据库；版本变化只使可重建的词典缓存失效。
const INDEX_VERSION = 3;
// 词性来自真实义项；派生列仅用于分页筛选，不改动发布词条或公共身份。
function entryPartsOfSpeech(entry) {
  const aliases = {
    n: "noun",
    v: "verb",
    adj: "adjective",
    a: "adjective",
    adv: "adverb",
    pron: "pronoun",
    prep: "preposition",
    conj: "conjunction",
    det: "determiner",
    interj: "interjection",
    int: "interjection",
    num: "numeral",
  };
  const known = new Set([...Object.values(aliases), "article", "auxiliary", "particle"]);
  return [
    ...new Set(
      (entry.senses || []).flatMap((sense) => {
        const raw = String(sense.pos || "")
          .trim()
          .toLowerCase()
          .replace(/\.$/, "");
        const pos = aliases[raw] || raw;
        return known.has(pos) ? [pos] : [];
      }),
    ),
  ];
}
const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function hashFile(file) {
  const hash = crypto.createHash("sha256");
  for await (const part of fs.createReadStream(file)) hash.update(part);
  return hash.digest("hex");
}
function manifest(directory) {
  const bytes = fs.readFileSync(path.join(directory, "release.json"));
  if (digest(bytes) !== MANIFEST_SHA) throw new Error("0.0.3 发布清单校验失败");
  const release = JSON.parse(bytes);
  if (
    release.schema_version !== "leximeet.release.v3" ||
    release.entry_schema !== "leximeet.entry.v2"
  )
    throw new Error("词典结构不兼容");
  return release;
}
function assetsFor(release, edition) {
  if (!["core-text", "full-text"].includes(edition)) throw new Error("仅支持 Core / Full Text");
  return release.editions[edition].assets;
}

// 一次性构建只读索引。逐行解压、独立暂存事务，公共正文按词压缩，不把整份词典读入内存。
async function buildIndex({ source, output, edition = "core-text", onProgress = () => {} }) {
  const { DatabaseSync } = require("node:sqlite");
  const release = manifest(source);
  const assets = assetsFor(release, edition);
  for (const name of assets) {
    const metadata = release.assets[name],
      file = path.join(source, name);
    if (fs.statSync(file).size !== metadata.bytes || (await hashFile(file)) !== metadata.sha256)
      throw new Error(`词典文件校验失败：${name}`);
  }
  const temporary = `${output}.${crypto.randomUUID()}.tmp`;
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const db = new DatabaseSync(temporary);
  let committed = false;
  try {
    db.exec(
      "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=MEMORY; CREATE TABLE entries(id TEXT PRIMARY KEY,headword TEXT NOT NULL,normalized TEXT NOT NULL,meaning TEXT NOT NULL,payload BLOB NOT NULL,position INTEGER NOT NULL); CREATE TABLE catalogs(id TEXT PRIMARY KEY,category TEXT NOT NULL,title TEXT NOT NULL,payload TEXT NOT NULL); CREATE TABLE members(catalog_id TEXT NOT NULL REFERENCES catalogs(id),entry_id TEXT NOT NULL REFERENCES entries(id),position INTEGER NOT NULL,sense_ids TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(catalog_id,entry_id)); CREATE TABLE metadata(id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL); BEGIN;",
    );
    const catalogs = JSON.parse(fs.readFileSync(path.join(source, "catalogs.json"))).catalogs;
    const addCatalog = db.prepare("INSERT INTO catalogs VALUES(?,?,?,?)");
    for (const item of catalogs)
      addCatalog.run(item.catalog_id, item.category, item.title_zh, JSON.stringify(item));
    const addEntry = db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?)");
    const addMember = db.prepare("INSERT INTO members VALUES(?,?,?,?,?)");
    db.exec(
      "CREATE TABLE entry_parts_of_speech(entry_id TEXT NOT NULL REFERENCES entries(id),pos TEXT NOT NULL,PRIMARY KEY(entry_id,pos));",
    );
    const addPos = db.prepare("INSERT INTO entry_parts_of_speech VALUES(?,?)");
    let count = 0;
    for (const name of assets.filter((name) => release.assets[name].kind === "entries")) {
      const stream = fs.createReadStream(path.join(source, name)).pipe(zlib.createZstdDecompress());
      const lines = jsonLines(stream);
      try {
        for await (const line of lines) {
          if (Buffer.byteLength(line) > 1_000_000) throw new Error("词典词条超过允许大小");
          const entry = JSON.parse(line);
          if (
            entry.schema_version !== "leximeet.entry.v2" ||
            !/^[a-f0-9-]{36}$/.test(entry.entry_id) ||
            !entry.headword
          )
            throw new Error("词典中存在无效词条");
          const meaning =
            entry.headword_summary_zh ||
            entry.senses?.[0]?.short_gloss ||
            entry.ecdict?.zh_fallback ||
            "暂无中文释义";
          addEntry.run(
            entry.entry_id,
            entry.headword,
            entry.lookup_key.normalize("NFKC").trim().toLowerCase(),
            meaning,
            zlib.deflateRawSync(line, { level: 1 }),
            count++,
          );
          for (const pos of entryPartsOfSpeech(entry)) addPos.run(entry.entry_id, pos);
          for (const member of entry.learning?.collections || [])
            addMember.run(
              member.catalog_id,
              entry.entry_id,
              member.position,
              JSON.stringify(member.sense_ids || []),
              JSON.stringify(member.source_payload || {}),
            );
          if (count % 2000 === 0)
            onProgress({
              state: "indexing",
              entries: count,
              total: release.editions[edition].entry_count,
            });
        }
      } finally {
        stream.destroy();
      }
    }
    if (count !== release.editions[edition].entry_count) throw new Error("词典数量与清单不一致");
    for (const item of catalogs)
      if (
        db.prepare("SELECT COUNT(*) AS n FROM members WHERE catalog_id=?").get(item.catalog_id)
          .n !== item.entry_count
      )
        throw new Error(`词库成员不完整：${item.title_zh}`);
    const metadata = {
      version: release.dictionary_version,
      edition,
      entryCount: count,
      catalogCount: catalogs.length,
      manifestSha: MANIFEST_SHA,
      payloadCodec: "deflate-raw",
      indexVersion: INDEX_VERSION,
      downloadBytes: release.editions[edition].download_bytes,
    };
    db.prepare("INSERT INTO metadata VALUES(1,?)").run(JSON.stringify(metadata));
    // LMCP 先按原词头精确匹配，再按查询键匹配；两条路径都要有索引。
    // 词头可能与 lookup_key 不同，不能为了性能把精确匹配改成归一键匹配。
    db.exec(
      `CREATE INDEX members_order ON members(catalog_id,position,entry_id); CREATE INDEX entries_order ON entries(position); CREATE INDEX entries_lookup ON entries(normalized,headword); CREATE INDEX entries_exact ON entries(headword,id); CREATE INDEX entries_pos ON entry_parts_of_speech(pos,entry_id); COMMIT; PRAGMA user_version=${INDEX_VERSION};`,
    );
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("词典索引完整性检查失败");
    db.close();
    committed = true;
    fs.renameSync(temporary, output);
    onProgress({ state: "ready", ...metadata });
    return {
      ...metadata,
      indexSha: await hashFile(output),
      indexBytes: fs.statSync(output).size,
    };
  } finally {
    if (!committed) {
      db.close();
      fs.rmSync(temporary, { force: true });
    }
  }
}
module.exports = {
  INDEX_VERSION,
  MANIFEST_SHA,
  RELEASE_URL,
  digest,
  hashFile,
  manifest,
  assetsFor,
  buildIndex,
  jsonLines,
  entryPartsOfSpeech,
};
