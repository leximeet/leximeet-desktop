"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
// 仅从已确认的透明品牌符号缩小导出，不去除背景、不重绘、不放大母版。
if (process.platform !== "darwin")
  throw new Error("重新导出需要 macOS；其他平台直接使用已提交资源。");
const directory = path.resolve(__dirname, "../resources/brand");
const source = path.join(directory, "symbol-source.png");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-transparent-icon-"));
try {
  const iconset = path.join(scratch, "LexiMeet.iconset");
  fs.mkdirSync(iconset);
  const files = new Map();
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
    const file = path.join(scratch, `${size}.png`);
    execFileSync("/usr/bin/sips", ["-z", String(size), String(size), source, "--out", file], {
      stdio: "pipe",
    });
    files.set(size, file);
  }
  for (const size of [16, 32, 128, 256, 512]) {
    fs.copyFileSync(files.get(size), path.join(iconset, `icon_${size}x${size}.png`));
    fs.copyFileSync(files.get(size * 2), path.join(iconset, `icon_${size}x${size}@2x.png`));
  }
  execFileSync("/usr/bin/iconutil", [
    "--convert",
    "icns",
    iconset,
    "--output",
    path.join(directory, "LexiMeet.icns"),
  ]);
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const images = sizes.map((size) => fs.readFileSync(files.get(size)));
  const header = Buffer.alloc(6 + 16 * sizes.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i;
    header[entry] = header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(images[i].length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(path.join(directory, "LexiMeet.ico"), Buffer.concat([header, ...images]));
  for (const file of ["icon.png", "icon-512x512.png"])
    fs.copyFileSync(files.get(512), path.join(directory, file));
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
