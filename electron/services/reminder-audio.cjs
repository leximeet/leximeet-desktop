"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

// macOS 系统通知的显式播放动作：复用发音提供者，临时文件用完删除，不拉起采集/练习窗口。
async function playReminderAudio(pronunciation, word, { silent = false } = {}) {
  const audio = await pronunciation.speak({ word });
  // 后台测试仍走提供者/缓存/失败链路，禁止另起 afplay 占用操作者的音频设备。
  // 扬声器听感与通知朗读的真实输出单独人工验收，不由此分支冒称通过。
  if (silent) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "leximeet-reminder-audio-"));
  try {
    const file = path.join(directory, "pronunciation.audio");
    await fs.writeFile(file, Buffer.from(audio.data, "base64"), {
      mode: 0o600,
    });
    await promisify(execFile)(
      "/usr/bin/afplay",
      ["-v", String(audio.volume ?? 1), "-r", String(audio.rate ?? 1), file],
      { timeout: 30000 },
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { playReminderAudio };
