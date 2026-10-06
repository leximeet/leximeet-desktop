"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough } = require("node:stream");
const {
  MAX_FRAME_BYTES,
  FrameDecoder,
  FrameWriter,
  encodeFrame,
  parseStrictJson,
} = require("../../electron/services/lmcp/framing.cjs");

test("原生帧允许任意字节切片与多帧连读，中文和 emoji 不丢失", () => {
  const expected = [{ text: "遇见 🦉" }, { n: 3 }];
  const frames = Buffer.concat(expected.map((x) => encodeFrame(x)));
  const decoder = new FrameDecoder();
  const received = [];
  decoder.on("message", (v) => received.push(v));
  decoder.on("error", (error) => {
    throw error;
  });
  for (const byte of frames) decoder.push(Buffer.from([byte]));
  decoder.finish();
  assert.deepEqual(received, expected);
});

test("严格 JSON 拒绝重复键、转义重复键和孤立代理项", () => {
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":1,"\\u0078":2}',
    '{"a":{"x":1,"x":2}}',
    '{"x":"\\ud800"}',
    '{"x":"\\udc00"}',
    '{"x":"\\ud800a"}',
    '{"x":1e999}',
    "true false",
  ])
    assert.throws(() => parseStrictJson(Buffer.from(text)), /INVALID_JSON/);
  assert.deepEqual(parseStrictJson(Buffer.from('{"x":"\\ud83e\\udd89"}')), { x: "🦉" });
});

test("重复键不因嵌套键或字符串中的花括号误判", () => {
  const value = { x: '{"x":1}', nested: { x: 2 }, escaped: '\\"' };
  assert.deepEqual(parseStrictJson(Buffer.from(JSON.stringify(value))), value);
});

test("无效 UTF-8、零长度、大帧和不完整帧明确失败", () => {
  assert.throws(() => parseStrictJson(Buffer.from([0xff, 0xfe])));
  for (const size of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
    const decoder = new FrameDecoder();
    let failed;
    decoder.on("error", (error) => {
      failed = error.message;
    });
    const head = Buffer.alloc(4);
    head.writeUInt32LE(size);
    decoder.push(head);
    assert.equal(failed, "INVALID_FRAME_LENGTH");
  }
  const decoder = new FrameDecoder();
  let failed;
  decoder.on("error", (error) => {
    failed = error.message;
  });
  decoder.push(Buffer.from([2, 0]));
  decoder.finish();
  assert.equal(failed, "TRUNCATED_FRAME");
});

test("256 KiB 上限按 UTF-8 字节计算，输出不允许孤立代理项", () => {
  assert.throws(() => encodeFrame({ text: "中".repeat(MAX_FRAME_BYTES / 3) }), /PAYLOAD_TOO_LARGE/);
  assert.throws(() => encodeFrame({ text: "\ud800" }), /INVALID_JSON/);
});

test("下游不读取时输出队列有界，不无限堆积", () => {
  const stream = new PassThrough({ highWaterMark: 1 });
  let reason;
  const writer = new FrameWriter(stream, {
    queueBytes: 100,
    onError: (error) => {
      reason = error.message;
    },
  });
  writer.send({ text: "first" });
  writer.send({ text: "second" });
  assert.throws(() => writer.send({ text: "x".repeat(100) }), /BACKPRESSURE_LIMIT/);
  assert.equal(reason, "BACKPRESSURE_LIMIT");
  writer.close();
  stream.destroy();
});
