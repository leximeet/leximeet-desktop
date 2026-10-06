"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PronunciationService } = require("../../electron/services/pronunciation.cjs");
const providers = require("../../electron/services/pronunciation-providers.cjs");
const mp3 = () => Buffer.concat([Buffer.from("ID3"), Buffer.alloc(60)]);
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-audio-unit-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(`encrypted:${Buffer.from(value).toString("base64")}`),
    decryptString: (value) => Buffer.from(value.toString().slice(10), "base64").toString(),
  };
  const service = new PronunciationService({
    directory,
    safeStorage,
    ...options,
  });
  t.after(() => {
    service.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { service, directory };
}
test("默认有道；主进程缓存、发音开始不完成、结束回执和取消互不产生遇见", async (t) => {
  let calls = 0;
  const facts = [];
  const { service } = fixture(t, {
    implementations: {
      youdao: async () => {
        calls++;
        return { bytes: mp3(), mime: "audio/mpeg" };
      },
    },
    nativeEvent: async (event) => facts.push(event),
  });
  assert.equal((await service.settings()).provider, "youdao");
  const first = await service.speak({ word: "serendipity" });
  assert.deepEqual(facts, []);
  await service.speak({ action: "played", playbackId: first.playbackId });
  assert.deepEqual(facts, []);
  await service.speak({ action: "completed", playbackId: first.playbackId });
  await service.speak({ action: "completed", playbackId: first.playbackId });
  assert.deepEqual(facts, ["audio"]);
  const second = await service.speak({ word: "serendipity" });
  assert.equal(calls, 1);
  assert.notEqual(first.playbackId, second.playbackId);
  await service.speak({ action: "cancel" });
  await assert.rejects(
    service.speak({ action: "completed", playbackId: second.playbackId }),
    /失效/,
  );
  await service.settings({ action: "clearCache" });
  await service.speak({ word: "serendipity" });
  assert.equal(calls, 2);
});
test("API 鉴权仅在 Main 解密，配置回显与磁盘文件不包含明文，失败也不泄露地址", async (t) => {
  let sent;
  const { service, directory } = fixture(t, {
    implementations: {
      custom: async (data) => {
        sent = data;
        return { bytes: mp3(), mime: "audio/mpeg" };
      },
    },
  });
  const secret = "Bearer private-test-key";
  const saved = await service.settings({
    action: "save",
    provider: "custom",
    custom: {
      url: "https://example.invalid/{word}",
      method: "POST",
      body: '{"input":"{word}"}',
    },
    headers: JSON.stringify({ Authorization: secret }),
  });
  assert.equal(saved.custom.hasSecret, true);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(
    fs.readFileSync(path.join(directory, "pronunciation.json"), "utf8").includes(secret),
    false,
  );
  await service.speak({ word: "alpha" });
  assert.equal(sent.headers.Authorization, secret);
  service.implementations.custom = async () => {
    throw new Error("https://example.invalid/private-test-key");
  };
  service.clearCache();
  await assert.rejects(
    service.speak({ word: "beta" }),
    (error) =>
      error.message.includes("自定义发音请求失败") && !error.message.includes("private-test-key"),
  );
  await service.settings({ action: "save", clearSecret: true });
  assert.equal((await service.settings()).custom.hasSecret, false);
});
test("有道与微软可回退；服务迟到结果在取消后不能交给播放", async (t) => {
  let release;
  const { service } = fixture(t, {
    implementations: {
      youdao: async () => {
        throw new Error("不可用");
      },
      microsoft: async () => ({ bytes: mp3(), mime: "audio/mpeg" }),
    },
  });
  assert.equal((await service.speak({ word: "alpha" })).provider, "microsoft");
  service.clearCache();
  service.implementations.youdao = () => new Promise((resolve) => (release = resolve));
  const pending = service.speak({ word: "beta" });
  service.cancel();
  release({ bytes: mp3(), mime: "audio/mpeg" });
  await assert.rejects(pending, /取消/);
});
test("微软 WebSocket 使用口音匹配声音、转义正文，并只接收有界音频帧", async () => {
  let socket;
  class FakeSocket extends EventEmitter {
    constructor(url, options) {
      super();
      socket = this;
      this.url = url;
      this.options = options;
      this.sent = [];
      queueMicrotask(() => this.emit("open"));
    }
    send(value) {
      this.sent.push(value);
    }
    terminate() {
      this.closed = true;
    }
  }
  const pending = providers.microsoft({
    word: "a<&",
    voice: "en-US-AriaNeural",
    accent: "uk",
    WebSocketImpl: FakeSocket,
  });
  await new Promise(setImmediate);
  assert.match(socket.sent[1], /en-GB-SoniaNeural/);
  assert.match(socket.sent[1], /a&lt;&amp;/);
  const header = Buffer.from("Path:audio\r\nContent-Type:audio/mpeg\r\n"),
    length = Buffer.alloc(2);
  length.writeUInt16BE(header.length);
  socket.emit("message", Buffer.concat([length, header, mp3()]), true);
  socket.emit("message", Buffer.from("Path:turn.end\r\n"), false);
  assert.equal((await pending).mime, "audio/mpeg");
  assert.equal(socket.closed, true);
});
test("自定义 GET/POST 编码和音频魔数校验；不把 JSON/HTML 当成功音频", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return new Response(mp3(), { status: 200 });
  };
  await providers.custom({
    word: "a & b",
    accent: "us",
    voice: "voice",
    config: { url: "https://example.invalid/audio?word={word}", method: "GET" },
    headers: {},
    fetchImpl,
  });
  assert.match(request.url, /a%20%26%20b/);
  await providers.custom({
    word: '"quoted"',
    accent: "uk",
    voice: "voice",
    config: {
      url: "https://example.invalid/audio",
      method: "POST",
      body: '{"input":"{word}","nested":["{accent}"]}',
    },
    headers: { Authorization: "test" },
    fetchImpl,
  });
  assert.deepEqual(JSON.parse(request.options.body), {
    input: '"quoted"',
    nested: ["uk"],
  });
  await assert.rejects(
    providers.responseAudio(new Response("html content that is not audio at all")),
    /不是支持的音频/,
  );
  assert.throws(() => providers.audioType(Buffer.alloc(3)), /有效音频/);
});
