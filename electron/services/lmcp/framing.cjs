"use strict";
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");
const { endianness } = require("node:os");
const MAX_FRAME_BYTES = 256 * 1024;
const nativeLittleEndian = endianness() === "LE";

// JSON.parse 会悄悄覆盖重复键；先走有界语法扫描，避免授权字段产生两种解释。
function parseStrictJson(bytes) {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  let at = 0;
  const space = () => {
    while (/\s/.test(source[at] || "") && at < source.length) at++;
  };
  const fail = () => {
    throw new Error("INVALID_JSON");
  };
  function string() {
    if (source[at] !== '"') fail();
    const start = at++;
    while (at < source.length) {
      const c = source[at++];
      if (c === '"') {
        const value = JSON.parse(source.slice(start, at));
        // Unicode 孤立代理项会被 JSON.parse 接受，跨 Java / JS 时必须拒绝。
        for (let i = 0; i < value.length; i++) {
          const code = value.charCodeAt(i);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(++i);
            if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
          } else if (code >= 0xdc00 && code <= 0xdfff) fail();
        }
        return value;
      }
      if (c === "\\") at++;
      else if (c.charCodeAt(0) < 32) fail();
    }
    fail();
  }
  function value(depth) {
    if (depth > 64) fail();
    space();
    if (source[at] === '"') return string();
    if (source[at] === "{") {
      at++;
      space();
      const keys = new Set();
      if (source[at] === "}") {
        at++;
        return;
      }
      for (;;) {
        space();
        const key = string();
        if (keys.has(key)) fail();
        keys.add(key);
        space();
        if (source[at++] !== ":") fail();
        value(depth + 1);
        space();
        const c = source[at++];
        if (c === "}") return;
        if (c !== ",") fail();
      }
    }
    if (source[at] === "[") {
      at++;
      space();
      if (source[at] === "]") {
        at++;
        return;
      }
      for (;;) {
        value(depth + 1);
        space();
        const c = source[at++];
        if (c === "]") return;
        if (c !== ",") fail();
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(at),
    );
    if (!match) fail();
    at += match[0].length;
  }
  value(0);
  space();
  if (at !== source.length) fail();
  const result = JSON.parse(source);
  function finite(item) {
    if (typeof item === "number" && !Number.isFinite(item)) fail();
    if (item && typeof item === "object") for (const child of Object.values(item)) finite(child);
  }
  finite(result);
  return result;
}

function encodeFrame(value, maximum = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (!body.length || body.length > maximum) throw new Error("PAYLOAD_TOO_LARGE");
  // 同样校验本进程产生的消息，防止孤立代理项被悄悄替换后传往浏览器。
  parseStrictJson(body);
  const head = Buffer.alloc(4);
  if (nativeLittleEndian) head.writeUInt32LE(body.length);
  else head.writeUInt32BE(body.length);
  return Buffer.concat([head, body]);
}

// 浏览器 stdio 与私有 UDS 采用相同原生端序头；单帧缓冲最多 256 KiB。
class FrameDecoder extends EventEmitter {
  constructor({ maximum = MAX_FRAME_BYTES } = {}) {
    super();
    this.maximum = maximum;
    this.header = Buffer.alloc(4);
    this.headerAt = 0;
    this.body = null;
    this.bodyAt = 0;
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    let offset = 0;
    try {
      while (offset < chunk.length) {
        if (!this.body) {
          const n = Math.min(4 - this.headerAt, chunk.length - offset);
          chunk.copy(this.header, this.headerAt, offset, offset + n);
          this.headerAt += n;
          offset += n;
          if (this.headerAt < 4) continue;
          const size = nativeLittleEndian ? this.header.readUInt32LE() : this.header.readUInt32BE();
          if (size < 1 || size > this.maximum) throw new Error("INVALID_FRAME_LENGTH");
          this.body = Buffer.alloc(size);
          this.bodyAt = 0;
          this.headerAt = 0;
        }
        const n = Math.min(this.body.length - this.bodyAt, chunk.length - offset);
        chunk.copy(this.body, this.bodyAt, offset, offset + n);
        this.bodyAt += n;
        offset += n;
        if (this.bodyAt === this.body.length) {
          const value = parseStrictJson(this.body);
          this.body = null;
          this.bodyAt = 0;
          this.emit("message", value);
          if (this.failed) return;
        }
      }
    } catch (error) {
      this.fail(error);
    }
  }
  finish() {
    if (this.headerAt || this.body) this.fail(new Error("TRUNCATED_FRAME"));
  }
  fail(error) {
    if (!this.failed) {
      this.failed = true;
      this.body = null;
      this.emit("error", error);
    }
  }
}

// 每条输出链有独立排队上限；对方不读时断开，不允许无限堆积私人消息。
class FrameWriter {
  constructor(
    stream,
    { maximum = MAX_FRAME_BYTES, queueBytes = 2 * MAX_FRAME_BYTES, onError = () => {} } = {},
  ) {
    this.stream = stream;
    this.maximum = maximum;
    this.limit = queueBytes;
    this.onError = onError;
    this.queue = [];
    this.queuedBytes = 0;
    this.waiting = false;
    this.closed = false;
    this.drained = () => {
      this.waiting = false;
      this.flush();
    };
    stream.on("drain", this.drained);
  }
  send(value) {
    if (this.closed) throw new Error("TRANSPORT_CLOSED");
    const frame = encodeFrame(value, this.maximum);
    if (this.queuedBytes + frame.length + (this.stream.writableLength || 0) > this.limit) {
      const error = new Error("BACKPRESSURE_LIMIT");
      this.onError(error);
      throw error;
    }
    this.queue.push(frame);
    this.queuedBytes += frame.length;
    this.flush();
  }
  flush() {
    while (!this.closed && !this.waiting && this.queue.length) {
      const frame = this.queue.shift();
      this.queuedBytes -= frame.length;
      this.waiting = !this.stream.write(frame);
    }
  }
  close() {
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.stream.off("drain", this.drained);
  }
}

module.exports = { MAX_FRAME_BYTES, FrameDecoder, FrameWriter, encodeFrame, parseStrictJson };
