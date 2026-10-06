"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Worker } = require("node:worker_threads");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const {
  MANIFEST_SHA,
  INDEX_VERSION,
  RELEASE_URL,
  manifest,
  assetsFor,
  hashFile,
} = require("./text-dictionary-index.cjs");

// 下载和建索引属于 Main，数据库挂载属于 Core；只有完整校验后的索引才能切换活动版本。
class TextDictionaryService {
  constructor({ core, profile, bundledPath, fetchImpl = fetch, localSource, changed = () => {} }) {
    Object.assign(this, {
      core,
      profile,
      bundledPath,
      fetchImpl,
      localSource,
      changed,
    });
    this.directory = path.join(profile.coreDir, "dictionaries");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.pointer = path.join(this.directory, "active.json");
    this.active = null;
    this.previous = null;
    this.operation = null;
    this.worker = null;
    this.progress = { state: "preparing" };
  }
  async ensure() {
    if (fs.existsSync(this.pointer)) {
      try {
        const saved = JSON.parse(fs.readFileSync(this.pointer));
        this.previous = saved.previous || null;
        await this.mount(saved.active);
        return;
      } catch {
        // 损坏索引不删除个人资料，回退到随包 Core。
        this.previous = null;
      }
    }
    const info = JSON.parse(fs.readFileSync(path.join(this.bundledPath, "core-text.sqlite.json")));
    if (info.indexVersion !== INDEX_VERSION)
      throw new Error("随包词典索引版本不兼容，请重新构建当前应用");
    const source = path.join(this.bundledPath, "core-text.sqlite");
    const name = `core-i${INDEX_VERSION}-${MANIFEST_SHA.slice(0, 12)}.sqlite`,
      output = path.join(this.directory, name);
    if (!fs.existsSync(output) || (await hashFile(output)) !== info.indexSha)
      fs.copyFileSync(source, output);
    await this.activate({ ...info, fileName: name });
  }
  async mount(info) {
    if (
      !info ||
      info.indexVersion !== INDEX_VERSION ||
      !/^[a-zA-Z0-9_-]+\.sqlite$/.test(info.fileName)
    )
      throw new Error("词典活动指针无效");
    const file = path.join(this.directory, info.fileName);
    if (
      !fs.existsSync(file) ||
      fs.lstatSync(file).isSymbolicLink() ||
      (await hashFile(file)) !== info.indexSha
    )
      throw new Error("活动词典索引校验失败");
    await this.core.request("/api/desktop/mount", "POST", {
      file,
      edition: info.edition,
      version: info.version,
      manifestSha: info.manifestSha,
      entryCount: info.entryCount,
    });
    this.active = info;
    this.progress = { state: "ready" };
    this.changed();
  }
  async activate(info) {
    const old = this.active;
    try {
      await this.mount(info);
      const pending = `${this.pointer}.tmp`;
      fs.writeFileSync(pending, JSON.stringify({ active: info, previous: old || this.previous }), {
        mode: 0o600,
      });
      fs.renameSync(pending, this.pointer);
      this.previous = old || this.previous;
    } catch (error) {
      if (old) await this.mount(old).catch(() => {});
      throw error;
    }
  }
  status() {
    return {
      active: this.active && {
        edition: this.active.edition,
        version: this.active.version,
        entryCount: this.active.entryCount,
      },
      previous: this.previous && {
        edition: this.previous.edition,
        version: this.previous.version,
      },
      progress: { ...this.progress },
      busy: Boolean(this.operation),
    };
  }
  action(input) {
    if (!input || Object.keys(input).some((key) => !["action", "edition"].includes(key)))
      throw new Error("词典操作参数无效");
    if (input.action === "status") return Promise.resolve(this.status());
    if (input.action === "cancel") {
      this.operation?.abort();
      return Promise.resolve(this.status());
    }
    if (input.action === "rollback") {
      if (this.operation || !this.previous) throw new Error("当前没有可回退的词典");
      return this.activate(this.previous).then(() => this.status());
    }
    if (input.action !== "install" || !["core-text", "full-text"].includes(input.edition))
      throw new Error("仅支持安装 Core / Full Text");
    if (this.operation) throw new Error("已有词典更新正在进行");
    return this.install(input.edition);
  }
  async install(edition) {
    const controller = new AbortController();
    this.operation = controller;
    const source = path.join(this.directory, "assets");
    fs.mkdirSync(source, { recursive: true });
    const staging = fs.mkdtempSync(path.join(this.directory, "install-"));
    let worker;
    try {
      const release = manifest(this.bundledPath);
      fs.copyFileSync(
        path.join(this.bundledPath, "release.json"),
        path.join(source, "release.json"),
      );
      const assets = assetsFor(release, edition);
      const missing = [];
      let reusedBytes = 0;
      for (const name of assets) {
        controller.signal.throwIfAborted();
        const file = path.join(source, name),
          bundled = path.join(this.bundledPath, name),
          asset = release.assets[name];
        if (!fs.existsSync(file) && fs.existsSync(bundled)) fs.copyFileSync(bundled, file);
        if (
          fs.existsSync(file) &&
          fs.statSync(file).size === asset.bytes &&
          (await hashFile(file)) === asset.sha256
        )
          reusedBytes += asset.bytes;
        else missing.push(name);
      }
      const deltaBytes = missing.reduce((sum, name) => sum + release.assets[name].bytes, 0);
      const disk = fs.statfsSync(this.directory);
      if (disk.bavail * disk.bsize < deltaBytes + (edition === "full-text" ? 2 : 1) * 1024 ** 3)
        throw new Error("空间不足，请为词典安装预留至少 1–2 GiB");
      let downloadedBytes = 0;
      this.progress = {
        state: "downloading",
        downloadedBytes,
        deltaBytes,
        reusedBytes,
      };
      this.changed();
      for (const name of missing) {
        controller.signal.throwIfAborted();
        const asset = release.assets[name],
          output = path.join(source, name),
          partial = path.join(staging, name);
        const local = this.localSource && path.join(this.localSource, name);
        if (local && fs.existsSync(local)) {
          fs.copyFileSync(local, partial);
          downloadedBytes += fs.statSync(partial).size;
        } else {
          const response = await this.fetchImpl(`${RELEASE_URL}${name}`, {
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
            redirect: "follow",
          });
          if (!response.ok) throw new Error(`词典下载失败（${response.status}）`);
          const body = Readable.fromWeb(response.body);
          body.on("data", (part) => {
            downloadedBytes += part.length;
            if (downloadedBytes > deltaBytes) controller.abort();
            this.progress = {
              state: "downloading",
              downloadedBytes,
              deltaBytes,
              reusedBytes,
            };
            this.changed();
          });
          await pipeline(body, fs.createWriteStream(partial), {
            signal: controller.signal,
          });
        }
        if (fs.statSync(partial).size !== asset.bytes || (await hashFile(partial)) !== asset.sha256)
          throw new Error(`词典下载校验失败：${name}`);
        fs.renameSync(partial, output);
      }
      controller.signal.throwIfAborted();
      const output = path.join(staging, "index.sqlite");
      const info = await new Promise((resolve, reject) => {
        worker = new Worker(path.join(__dirname, "text-dictionary-worker.cjs"), {
          workerData: { source, output, edition },
        });
        this.worker = worker;
        const abort = () => {
          worker.terminate();
          reject(new Error("已取消词典安装"));
        };
        controller.signal.addEventListener("abort", abort, { once: true });
        worker.on("message", (message) => {
          if (message.progress) {
            this.progress = { ...message.progress, reusedBytes, deltaBytes };
            this.changed();
          }
          if (message.result) {
            controller.signal.removeEventListener("abort", abort);
            resolve(message.result);
          }
          if (message.error) reject(new Error(message.error));
        });
        worker.once("error", reject);
        worker.once("exit", (code) => {
          if (code) reject(new Error("词典索引构建中止"));
        });
      });
      controller.signal.throwIfAborted();
      const fileName = `${edition}-${crypto.randomUUID()}.sqlite`;
      fs.renameSync(output, path.join(this.directory, fileName));
      await this.activate({ ...info, fileName });
      this.progress = { state: "ready", reusedBytes, deltaBytes };
      return this.status();
    } catch (error) {
      this.progress = {
        state: controller.signal.aborted ? "cancelled" : "failed",
        error: controller.signal.aborted ? "已取消，原活动词典保持可用" : error.message,
      };
      throw new Error(this.progress.error);
    } finally {
      await worker?.terminate();
      this.worker = null;
      this.operation = null;
      fs.rmSync(staging, { recursive: true, force: true });
      this.changed();
    }
  }
  async close() {
    this.operation?.abort();
    await this.worker?.terminate();
  }
}
module.exports = { TextDictionaryService };
