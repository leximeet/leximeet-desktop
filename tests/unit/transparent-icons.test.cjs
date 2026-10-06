"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { decodePNG } = require("../helpers/png.cjs");
const directory = path.resolve(__dirname, "../../resources/brand");
function transparent(png, size) {
  const image = decodePNG(png);
  assert.equal(image.width, size);
  assert.equal(image.height, size);
  const at = (x, y) => image.rgba[(y * size + x) * 4 + 3];
  assert.equal(at(0, 0), 0);
  // 旧图标底板的内部，此处也必须透明；不能只检查外侧圆角。
  assert.equal(at(Math.round(size * 0.5), Math.round(size * 0.1)), 0);
  assert.ok(at(Math.round(size * 0.3), Math.round(size * 0.5)) > 200);
}
test("通知与Dock PNG为透明品牌符号，ICO每层也无白色底板", () => {
  for (const file of ["icon.png", "icon-512x512.png"])
    transparent(fs.readFileSync(path.join(directory, file)), 512);
  const ico = fs.readFileSync(path.join(directory, "LexiMeet.ico"));
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  assert.equal(count, 7);
  for (let i = 0; i < count; i++) {
    const offset = 6 + i * 16,
      size = ico[offset] || 256;
    transparent(
      ico.subarray(
        ico.readUInt32LE(offset + 12),
        ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8),
      ),
      size,
    );
  }
  const icns = fs.readFileSync(path.join(directory, "LexiMeet.icns"));
  assert.equal(icns.toString("ascii", 0, 4), "icns");
  assert.equal(icns.readUInt32BE(4), icns.length);
});
