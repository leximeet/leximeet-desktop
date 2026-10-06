"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const MAX_PACKAGE_BYTES = 1024 * 1024 * 1024;
const platformKey = (platform = process.platform, arch = process.arch) => `${platform}-${arch}`;

// 当前发布格式只接受完整 SemVer；版本从不作为任意路径使用。
function parseVersion(value) {
  if (
    typeof value !== "string" ||
    value.length > 120 ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
      value,
    )
  )
    throw new Error("更新版本号格式无效");
  const [release, pre = ""] = value.split("+")[0].split(/-(.*)/s);
  const numeric = release.split(".").map(Number);
  const identifiers = pre ? pre.split(".") : [];
  if (numeric.some((n) => !Number.isSafeInteger(n)) || identifiers.some((s) => /^0\d+$/.test(s)))
    throw new Error("更新版本号格式无效");
  return { numeric, identifiers };
}
function compareVersions(left, right) {
  const a = parseVersion(left),
    b = parseVersion(right);
  for (let i = 0; i < 3; i++) {
    if (a.numeric[i] !== b.numeric[i]) return a.numeric[i] > b.numeric[i] ? 1 : -1;
  }
  if (!a.identifiers.length || !b.identifiers.length)
    return Number(!a.identifiers.length) - Number(!b.identifiers.length);
  for (let i = 0; i < Math.max(a.identifiers.length, b.identifiers.length); i++) {
    const x = a.identifiers[i],
      y = b.identifiers[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x),
      yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}
function sourceUrl(value, allowInsecureLocal) {
  const url = new URL(value);
  const local =
    allowInsecureLocal && url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname);
  if ((!local && url.protocol !== "https:") || url.username || url.password)
    throw new Error("更新源必须使用无凭据的 HTTPS 地址");
  return url.href;
}
// 流式读取有固定预算；取消后即使测试源继续返回数据也不能落盘。
async function consume(response, limit, signal, write) {
  if (!response.ok) throw new Error(`更新源不可用（HTTP ${response.status}）`);
  if (!response.body) throw new Error("更新响应没有正文");
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit))
    throw new Error("更新响应体积超过预算");
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.byteLength;
    if (size > limit) throw new Error("更新包大小超过声明长度");
    await write(chunk, size);
  }
  signal.throwIfAborted();
  return size;
}
async function sha256File(file) {
  const hash = createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

// 只下载并校验候选；不安装、不暂停、不改写正在运行的应用。
class AppUpdater {
  constructor({
    feedUrl = "",
    downloadDir,
    fetchImpl = globalThis.fetch,
    currentVersion = require("../../package.json").version,
    platform = process.platform,
    arch = process.arch,
    allowInsecureLocal = false,
  } = {}) {
    Object.assign(this, {
      feedUrl,
      downloadDir,
      fetchImpl,
      currentVersion,
      platform,
      arch,
      allowInsecureLocal,
    });
    this.inflight = null;
    this.progress = { status: "idle", received: 0, total: 0 };
    this.closed = false;
  }
  configured() {
    return Boolean(this.feedUrl);
  }
  async check({ signal: outer } = {}) {
    if (this.closed) throw new Error("更新服务已关闭");
    if (!this.feedUrl)
      return {
        status: "not-configured",
        reason: "尚未配置受信任的更新源，当前可手动安装新版本",
        pauseSupported: false,
      };
    const signal = outer
      ? AbortSignal.any([outer, AbortSignal.timeout(8000)])
      : AbortSignal.timeout(8000);
    const response = await this.fetchImpl(sourceUrl(this.feedUrl, this.allowInsecureLocal), {
      redirect: "error",
      signal,
    });
    const chunks = [];
    await consume(response, 256 * 1024, signal, (chunk) => chunks.push(Buffer.from(chunk)));
    const feed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const key = platformKey(this.platform, this.arch),
      asset = feed?.assets?.[key];
    if (asset === undefined)
      return {
        status: "unsupported",
        reason: `当前平台 ${key} 没有可用更新包`,
        pauseSupported: false,
      };
    if (
      !asset ||
      typeof asset !== "object" ||
      Array.isArray(asset) ||
      typeof asset.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(asset.sha256) ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 1 ||
      asset.size > MAX_PACKAGE_BYTES ||
      typeof asset.url !== "string" ||
      asset.url.length > 4096 ||
      (asset.range !== undefined && typeof asset.range !== "boolean")
    )
      throw new Error("更新清单字段或大小无效");
    const ranking = compareVersions(asset.version, this.currentVersion);
    const url = sourceUrl(asset.url, this.allowInsecureLocal);
    return {
      status: ranking < 0 ? "older" : ranking === 0 ? "up-to-date" : "available",
      ...(ranking < 0
        ? { reason: `更新源 ${asset.version} 低于当前 ${this.currentVersion}，未下载` }
        : {}),
      version: asset.version,
      currentVersion: this.currentVersion,
      sha256: asset.sha256,
      size: asset.size,
      url,
      pauseSupported: false,
      rangeSupported: asset.range === true,
    };
  }
  async download({ cancel } = {}) {
    if (this.inflight) throw new Error("已有更新下载正在进行");
    if (this.closed) throw new Error("更新服务已关闭");
    const controller = new AbortController();
    this.inflight = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]);
    let temp, handle;
    this.progress = { status: "checking", received: 0, total: 0 };
    try {
      cancel?.(() => controller.abort());
      const info = await this.check({ signal });
      signal.throwIfAborted();
      if (info.status !== "available") return info;
      fs.mkdirSync(this.downloadDir, { recursive: true, mode: 0o700 });
      // 已验证版本仍加哈希作为标识，禁止来自清单的任意路径/文件名。
      temp = path.join(this.downloadDir, `incomplete-${info.sha256}.part`);
      const finalName = path.join(this.downloadDir, `LexiMeet-${info.version}.bin`);
      if (
        fs.existsSync(finalName) &&
        fs.lstatSync(finalName).isFile() &&
        fs.statSync(finalName).size === info.size &&
        (await sha256File(finalName)) === info.sha256
      ) {
        signal.throwIfAborted();
        return { ...info, status: "downloaded", file: finalName };
      }
      fs.rmSync(temp, { force: true });
      handle = await fs.promises.open(temp, "wx", 0o600);
      this.progress = { status: "downloading", received: 0, total: info.size };
      const response = await this.fetchImpl(info.url, { redirect: "error", signal });
      const hash = createHash("sha256");
      const size = await consume(response, info.size, signal, async (chunk, received) => {
        hash.update(chunk);
        await handle.writeFile(chunk);
        this.progress = { status: "downloading", received, total: info.size };
      });
      if (size !== info.size) throw new Error("更新包校验失败：大小与声明不符");
      if (hash.digest("hex") !== info.sha256) throw new Error("更新包校验失败，未保留为可安装候选");
      await handle.close();
      handle = null;
      signal.throwIfAborted();
      fs.renameSync(temp, finalName);
      return { ...info, status: "downloaded", file: finalName, rangeUsed: false };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("已取消更新下载，未完成文件已删除");
      if (signal.aborted) throw new Error("更新下载超时，未完成文件已删除");
      throw error;
    } finally {
      await handle?.close();
      if (temp) fs.rmSync(temp, { force: true });
      this.inflight = null;
      this.progress = { status: "idle", received: 0, total: 0 };
    }
  }
  close() {
    this.closed = true;
    this.inflight?.abort();
  }
}
module.exports = { AppUpdater, platformKey, compareVersions };
