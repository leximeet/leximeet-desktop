// 只读 PNG 解码，用于检查透明区域与裁切安全区；不修改图片。
const { inflateSync } = require("node:zlib");
const assert = require("node:assert/strict");

function decodePNG(data) {
  assert.equal(data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "PNG 签名错误");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  const depth = data[24],
    type = data[25],
    channels = type === 6 ? 4 : 3;
  assert.ok(
    depth === 8 && [2, 6].includes(type) && data[28] === 0,
    "仅接受本包使用的 8 位非交错 RGB / RGBA",
  );
  const idat = [];
  let position = 8,
    ended = false;
  while (position < data.length) {
    const length = data.readUInt32BE(position);
    assert.ok(position + length + 12 <= data.length, "PNG 块越界");
    const kind = data.toString("ascii", position + 4, position + 8);
    if (kind === "IDAT") idat.push(data.subarray(position + 8, position + 8 + length));
    if (kind === "IEND") ended = true;
    position += length + 12;
  }
  assert.ok(ended && idat.length, "PNG 数据不完整");
  const raw = inflateSync(Buffer.concat(idat)),
    stride = width * channels;
  assert.equal(raw.length, height * (stride + 1), "PNG 解压长度错误");
  const decoded = Buffer.alloc(width * height * channels);
  const paeth = (a, b, c) => {
    const p = a + b - c,
      pa = Math.abs(p - a),
      pb = Math.abs(p - b),
      pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert.ok(filter <= 4, "未知 PNG 滤波器");
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= channels ? decoded[i - channels] : 0;
      const above = y ? decoded[i - stride] : 0;
      const upperLeft = y && x >= channels ? decoded[i - stride - channels] : 0;
      const predictor = [
        0,
        left,
        above,
        Math.floor((left + above) / 2),
        paeth(left, above, upperLeft),
      ][filter];
      decoded[i] = (raw[y * (stride + 1) + 1 + x] + predictor) & 255;
    }
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = decoded[i * channels + c];
    rgba[i * 4 + 3] = channels === 4 ? decoded[i * channels + 3] : 255;
  }
  return { width, height, rgba };
}

module.exports = { decodePNG };
