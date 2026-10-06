"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const providers = require("./pronunciation-providers.cjs");

const defaults = () => ({
  provider: "youdao",
  accent: "us",
  voice: "en-US-AriaNeural",
  rate: 1,
  volume: 0.8,
  fallback: true,
  custom: { url: "", method: "GET", body: "" },
});

// 提供者可替换；设置只回显非敏感字段，鉴权头通过系统安全存储加密，音频缓存只在内存。
class PronunciationService {
  constructor({
    directory,
    safeStorage,
    fetchImpl = fetch,
    implementations = providers,
    nativeEvent = async () => {},
    agent,
  }) {
    Object.assign(this, {
      safeStorage,
      fetchImpl,
      implementations,
      nativeEvent,
      agent,
    });
    this.file = path.join(directory, "pronunciation.json");
    this.preferences = defaults();
    this.secret = null;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.inflight = null;
    this.generation = 0;
    if (fs.existsSync(this.file)) {
      const saved = JSON.parse(fs.readFileSync(this.file));
      this.preferences = { ...defaults(), ...saved.preferences };
      this.secret = saved.secret || null;
    }
  }
  publicSettings() {
    return {
      ...this.preferences,
      custom: { ...this.preferences.custom, hasSecret: Boolean(this.secret) },
      voices: providers.EDGE_VOICES,
    };
  }
  async settings(input = { action: "get" }) {
    if (input.action === "get") return this.publicSettings();
    if (input.action === "clearCache" && Object.keys(input).length === 1) {
      this.cancel();
      this.clearCache();
      return this.publicSettings();
    }
    if (
      input.action !== "save" ||
      Object.keys(input).some(
        (key) =>
          ![
            "action",
            "provider",
            "accent",
            "voice",
            "rate",
            "volume",
            "fallback",
            "custom",
            "headers",
            "clearSecret",
          ].includes(key),
      )
    )
      throw new Error("发音设置参数无效");
    const next = {
      ...this.preferences,
      ...Object.fromEntries(
        Object.entries(input).filter(
          ([key]) => !["action", "headers", "clearSecret", "custom"].includes(key),
        ),
      ),
    };
    if (
      !["youdao", "microsoft", "custom"].includes(next.provider) ||
      !["us", "uk"].includes(next.accent) ||
      typeof next.fallback !== "boolean" ||
      !Number.isFinite(next.rate) ||
      next.rate < 0.5 ||
      next.rate > 2 ||
      !Number.isFinite(next.volume) ||
      next.volume < 0 ||
      next.volume > 1
    )
      throw new Error("发音选项超出范围");
    if (!providers.EDGE_VOICES.some((voice) => voice.id === next.voice))
      throw new Error("请选择提供的微软声音");
    if (input.custom) {
      if (Object.keys(input.custom).some((key) => !["url", "method", "body"].includes(key)))
        throw new Error("自定义发音参数无效");
      next.custom = { ...next.custom, ...input.custom };
      if (next.custom.url) {
        const url = new URL(next.custom.url);
        if (
          url.protocol !== "https:" &&
          !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
        )
          throw new Error("自定义 API 需要 HTTPS，或本机回环地址");
        if (url.username || url.password || next.custom.url.length > 2000)
          throw new Error("请将 API 凭证放入鉴权头");
      }
      if (
        !["GET", "POST"].includes(next.custom.method) ||
        typeof next.custom.body !== "string" ||
        next.custom.body.length > 4000
      )
        throw new Error("自定义请求格式无效");
      if (next.custom.method === "POST") {
        const value = JSON.parse(next.custom.body || "{}");
        if (!value || Array.isArray(value) || typeof value !== "object")
          throw new Error("POST 正文应为 JSON 对象");
      }
    }
    if (next.provider === "custom" && !next.custom.url) throw new Error("请先填写自定义 API 地址");
    let secret = input.clearSecret ? null : this.secret;
    if (input.headers !== undefined && input.headers !== "") {
      if (typeof input.headers !== "string" || input.headers.length > 4000)
        throw new Error("鉴权头应为 JSON 对象");
      const headers = JSON.parse(input.headers);
      if (
        !headers ||
        Array.isArray(headers) ||
        typeof headers !== "object" ||
        Object.entries(headers).some(
          ([key, value]) =>
            !/^[a-zA-Z0-9-]+$/.test(key) ||
            ["host", "content-length", "connection", "cookie"].includes(key.toLowerCase()) ||
            typeof value !== "string" ||
            /[\r\n]/.test(value),
        )
      )
        throw new Error("鉴权头格式无效");
      if (
        !this.safeStorage?.isEncryptionAvailable() ||
        this.safeStorage.getSelectedStorageBackend?.() === "basic_text"
      )
        throw new Error("系统安全存储不可用，无法保存 API 凭证");
      secret = this.safeStorage.encryptString(JSON.stringify(headers)).toString("base64");
    }
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ preferences: next, secret }), {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.file);
    this.cancel();
    this.clearCache();
    this.preferences = next;
    this.secret = secret;
    return this.publicSettings();
  }
  cancel() {
    this.generation++;
    this.inflight?.abort();
    this.inflight = null;
    this.playback = null;
  }
  clearCache() {
    this.cache.clear();
    this.cacheBytes = 0;
  }
  async speak(input) {
    if (["played", "completed"].includes(input?.action)) {
      if (
        Object.keys(input).some((key) => !["action", "playbackId"].includes(key)) ||
        !this.playback ||
        this.playback.id !== input.playbackId ||
        this.playback.expires < Date.now()
      )
        throw new Error("发音播放已经失效");
      // 开始播放的旧回执仅确认令牌；自然结束的完成回执才推进教学。
      if (input.action === "played") return { playing: true };
      if (!this.playback.recorded) {
        this.playback.recorded = true;
        await this.nativeEvent("audio");
      }
      return { completed: true };
    }
    if (input?.action === "cancel") {
      this.cancel();
      return { cancelled: true };
    }
    if (
      !input ||
      Object.keys(input).some((key) => !["word", "accent"].includes(key)) ||
      typeof input.word !== "string" ||
      !input.word.trim() ||
      input.word.length > 120 ||
      /[\x00-\x1f]/.test(input.word)
    )
      throw new Error("请输入有效词头");
    this.cancel();
    const generation = this.generation;
    const controller = new AbortController();
    this.inflight = controller;
    const preferences = structuredClone(this.preferences),
      accent = input.accent || preferences.accent;
    if (!["us", "uk"].includes(accent)) throw new Error("发音口音无效");
    const key = JSON.stringify([input.word, preferences.provider, preferences.voice, accent]);
    try {
      let audio = this.cache.get(key),
        usedProvider = preferences.provider;
      if (!audio) {
        const chain =
          preferences.fallback && preferences.provider !== "custom"
            ? [preferences.provider, preferences.provider === "youdao" ? "microsoft" : "youdao"]
            : [preferences.provider];
        let failure;
        for (const provider of chain) {
          try {
            const headers = this.secret
              ? JSON.parse(this.safeStorage.decryptString(Buffer.from(this.secret, "base64")))
              : {};
            audio = await this.implementations[provider]({
              word: input.word,
              accent,
              voice: preferences.voice,
              config: preferences.custom,
              headers,
              fetchImpl: this.fetchImpl,
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
              agent: this.agent,
            });
            usedProvider = provider;
            break;
          } catch (error) {
            failure = error;
            if (controller.signal.aborted) throw new Error("发音请求已取消");
          }
        }
        if (!audio)
          throw new Error(
            preferences.provider === "custom"
              ? "自定义发音请求失败，请检查地址、鉴权和响应音频格式"
              : failure?.message || "发音服务暂时不可用",
          );
        audio.provider = usedProvider;
        if (audio.bytes.length > providers.MAX_AUDIO_BYTES) throw new Error("音频过大");
        while (
          this.cache.size &&
          (this.cache.size >= 128 || this.cacheBytes + audio.bytes.length > 32 * 1024 * 1024)
        ) {
          const oldest = this.cache.keys().next().value;
          this.cacheBytes -= this.cache.get(oldest).bytes.length;
          this.cache.delete(oldest);
        }
        this.cache.set(key, audio);
        this.cacheBytes += audio.bytes.length;
      }
      if (generation !== this.generation) throw new Error("发音请求已取消");
      this.playback = {
        id: randomUUID(),
        expires: Date.now() + 60000,
        recorded: false,
      };
      return {
        data: audio.bytes.toString("base64"),
        mime: audio.mime,
        provider: audio.provider,
        rate: preferences.rate,
        volume: preferences.volume,
        word: input.word,
        playbackId: this.playback.id,
      };
    } finally {
      if (generation === this.generation) this.inflight = null;
    }
  }
  close() {
    this.cancel();
    this.clearCache();
  }
}
module.exports = { PronunciationService, defaults };
