"use strict";
const crypto = require("node:crypto");
const WebSocket = require("ws");
const { HttpsProxyAgent } = require("https-proxy-agent");
const MAX_AUDIO_BYTES = 2 * 1024 * 1024;
const CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const EDGE_VOICES = Object.freeze([
  { id: "en-US-AriaNeural", name: "Aria · 美式女声", accent: "us" },
  { id: "en-US-GuyNeural", name: "Guy · 美式男声", accent: "us" },
  { id: "en-GB-SoniaNeural", name: "Sonia · 英式女声", accent: "uk" },
  { id: "en-GB-RyanNeural", name: "Ryan · 英式男声", accent: "uk" },
]);
const xml = (value) =>
  value.replace(
    /[&<>"']/g,
    (symbol) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[symbol],
  );
function audioType(bytes, supplied = "") {
  if (bytes.length < 20) throw new Error("服务没有返回有效音频");
  const mp3 =
    bytes.subarray(0, 3).toString() === "ID3" || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0);
  const wav = bytes.subarray(0, 4).toString() === "RIFF";
  const ogg = bytes.subarray(0, 4).toString() === "OggS";
  if (!mp3 && !wav && !ogg) throw new Error("服务返回的内容不是支持的音频");
  return wav ? "audio/wav" : ogg ? "audio/ogg" : "audio/mpeg";
}
async function responseAudio(response) {
  if (!response.ok) throw new Error(`发音服务返回 ${response.status}`);
  let size = 0;
  const pieces = [];
  for await (const piece of response.body) {
    size += piece.byteLength;
    if (size > MAX_AUDIO_BYTES) {
      await response.body.cancel?.().catch(() => {});
      throw new Error("音频响应超过 2 MiB");
    }
    pieces.push(Buffer.from(piece));
  }
  const bytes = Buffer.concat(pieces);
  return { bytes, mime: audioType(bytes) };
}
async function youdao({ word, accent, fetchImpl = fetch, signal }) {
  const url = new URL("https://dict.youdao.com/dictvoice");
  url.searchParams.set("audio", word);
  url.searchParams.set("type", accent === "uk" ? "1" : "2");
  return responseAudio(await fetchImpl(url.href, { signal, redirect: "error" }));
}

// Edge 消费者朗读接口的兼容适配，不需要 Azure 订阅。接口变化时由提供者层隔离失败。
function microsoft({ word, voice, accent, signal, WebSocketImpl = WebSocket, agent }) {
  const ticks = (BigInt(Date.now()) + 11644473600000n) * 10000n;
  const snapped = ticks - (ticks % 3000000000n);
  const gec = crypto
    .createHash("sha256")
    .update(`${snapped}${CLIENT_TOKEN}`)
    .digest("hex")
    .toUpperCase();
  const connection = crypto.randomUUID().replaceAll("-", "");
  const url = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${CLIENT_TOKEN}&ConnectionId=${connection}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=1-143.0.3650.75`;
  const selected =
    EDGE_VOICES.find((item) => item.id === voice && item.accent === accent)?.id ||
    (accent === "uk" ? "en-GB-SoniaNeural" : "en-US-AriaNeural");
  const proxy =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!agent && proxy && /^https?:\/\//.test(proxy)) agent = new HttpsProxyAgent(proxy);
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = new WebSocketImpl(url, {
      headers: {
        Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
      },
      handshakeTimeout: 12000,
      maxPayload: MAX_AUDIO_BYTES,
      perMessageDeflate: false,
      ...(agent ? { agent } : {}),
    });
    const pieces = [];
    let total = 0,
      settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      socket.terminate();
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(new Error("发音请求已取消"));
    const timeout = setTimeout(() => finish(new Error("微软朗读服务超时")), 15000);
    signal?.addEventListener("abort", abort, { once: true });
    socket.on("error", () => finish(new Error("微软朗读服务暂时不可用")));
    socket.on("close", () => {
      if (!settled) finish(new Error("微软朗读服务未返回完整音频"));
    });
    socket.on("open", () => {
      const stamp = new Date().toUTCString();
      socket.send(
        `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n${JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: "false", wordBoundaryEnabled: "false" }, outputFormat: "audio-24khz-48kbitrate-mono-mp3" } } } })}`,
      );
      socket.send(
        `X-RequestId:${connection}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}\r\nPath:ssml\r\n\r\n<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${selected}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${xml(word)}</prosody></voice></speak>`,
      );
    });
    socket.on("message", (data, binary) => {
      try {
        if (binary) {
          if (data.length < 2) throw new Error("微软音频帧无效");
          const headerLength = data.readUInt16BE(0);
          if (headerLength + 2 > data.length) throw new Error("微软音频帧不完整");
          if (
            !data
              .subarray(2, headerLength + 2)
              .toString()
              .includes("Path:audio")
          )
            return;
          const piece = data.subarray(headerLength + 2);
          total += piece.length;
          if (total > MAX_AUDIO_BYTES) throw new Error("音频响应超过 2 MiB");
          pieces.push(piece);
        } else if (data.toString().includes("Path:turn.end")) {
          const bytes = Buffer.concat(pieces);
          finish(null, { bytes, mime: audioType(bytes) });
        }
      } catch (error) {
        finish(error);
      }
    });
  });
}
async function custom({ word, accent, voice, config, headers, fetchImpl, signal }) {
  const substitute = (value) =>
    String(value)
      .replaceAll("{word}", word)
      .replaceAll("{accent}", accent)
      .replaceAll("{voice}", voice || "");
  const endpoint = config.url
    .replaceAll("{word}", encodeURIComponent(word))
    .replaceAll("{accent}", accent)
    .replaceAll("{voice}", encodeURIComponent(voice || ""));
  let body;
  if (config.method === "POST") {
    const parsed = JSON.parse(config.body || '{"input":"{word}","voice":"{voice}"}');
    const replace = (value) =>
      Array.isArray(value)
        ? value.map(replace)
        : value && typeof value === "object"
          ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replace(item)]))
          : typeof value === "string"
            ? substitute(value)
            : value;
    body = JSON.stringify(replace(parsed));
  }
  return responseAudio(
    await fetchImpl(endpoint, {
      method: config.method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body } : {}),
      signal,
      redirect: "error",
    }),
  );
}
module.exports = {
  youdao,
  microsoft,
  custom,
  responseAudio,
  audioType,
  EDGE_VOICES,
  MAX_AUDIO_BYTES,
};
