"use strict";
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");

const MAX_MESSAGE_BYTES = 256 * 1024;

// 官方 MCP stdio 使用 LSP 风格的 Content-Length；与 LMCP 的 4 字节帧分开。
function encodeStdio(value, maximum = MAX_MESSAGE_BYTES) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (!body.length || body.length > maximum) throw new Error("PAYLOAD_TOO_LARGE");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

class StdioDecoder extends EventEmitter {
  constructor({ maximum = MAX_MESSAGE_BYTES } = {}) {
    super();
    this.maximum = maximum;
    this.buffer = Buffer.alloc(0);
    this.failed = false;
  }
  push(chunk) {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      while (this.parseOne()) {
        /* 连续拆出完整 JSON-RPC */
      }
    } catch (error) {
      this.fail(error);
    }
  }
  parseOne() {
    const text = this.buffer.toString("ascii");
    const separator = text.indexOf("\r\n\r\n");
    if (separator < 0) return false;
    const headers = text.slice(0, separator);
    const match = /^Content-Length:\s*(\d+)\s*$/im.exec(headers);
    if (!match) throw new Error("INVALID_STDIO_HEADER");
    const size = Number(match[1]);
    if (!Number.isInteger(size) || size < 1 || size > this.maximum)
      throw new Error("INVALID_FRAME_LENGTH");
    const start = separator + 4;
    if (this.buffer.length < start + size) return false;
    const body = this.buffer.subarray(start, start + size);
    this.buffer = this.buffer.subarray(start + size);
    const source = new TextDecoder("utf-8", { fatal: true }).decode(body);
    this.emit("message", JSON.parse(source));
    return true;
  }
  finish() {
    if (this.buffer.length) this.fail(new Error("TRUNCATED_FRAME"));
  }
  fail(error) {
    if (!this.failed) {
      this.failed = true;
      this.emit("error", error);
    }
  }
}

module.exports = { MAX_MESSAGE_BYTES, encodeStdio, StdioDecoder };
