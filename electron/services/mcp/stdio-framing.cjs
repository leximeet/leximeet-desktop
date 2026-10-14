"use strict";
const { EventEmitter } = require("node:events");
const { TextDecoder } = require("node:util");

const MAX_MESSAGE_BYTES = 256 * 1024;

// 官方 MCP stdio 以换行分隔 JSON-RPC，消息内不得含裸换行；与 LMCP 的 4 字节帧分开。
function encodeStdio(value, maximum = MAX_MESSAGE_BYTES) {
  const text = JSON.stringify(value);
  if (!text || text.includes("\n") || text.includes("\r") || text.length > maximum)
    throw new Error("PAYLOAD_TOO_LARGE");
  return Buffer.from(`${text}\n`, "utf8");
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
    const newline = this.buffer.indexOf(0x0a);
    if (newline < 0) {
      if (this.buffer.length > this.maximum) throw new Error("INVALID_FRAME_LENGTH");
      return false;
    }
    let line = this.buffer.subarray(0, newline);
    this.buffer = this.buffer.subarray(newline + 1);
    if (line.length && line[line.length - 1] === 0x0d) line = line.subarray(0, line.length - 1);
    if (!line.length) return true;
    if (line.length > this.maximum) throw new Error("INVALID_FRAME_LENGTH");
    const source = new TextDecoder("utf-8", { fatal: true }).decode(line);
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
