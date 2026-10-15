"use strict";
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFile, execFileSync } = require("node:child_process");
const { promisify } = require("node:util");

function firstOnPath(names) {
  for (const name of names) {
    try {
      const result = execFileSync(process.platform === "win32" ? "where" : "which", [name], {
        encoding: "utf8",
        windowsHide: true,
        timeout: 3000,
      });
      const file = result.trim().split(/\r?\n/)[0];
      if (file) return file;
    } catch {
      /* 继续尝试下一个 */
    }
  }
  return "";
}

function playerCommand(file, audio, platform = process.platform) {
  if (platform === "darwin")
    return {
      command: "/usr/bin/afplay",
      args: ["-v", String(audio.volume ?? 1), "-r", String(audio.rate ?? 1), file],
    };
  if (platform === "win32") {
    const quoted = file.replace(/'/g, "''");
    const { windowsPowerShellBinary } = require("./platform/identity.cjs");
    return {
      command: windowsPowerShellBinary(),
      args: [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(New-Object Media.SoundPlayer '${quoted}').PlaySync()`,
      ],
    };
  }
  const paplay = firstOnPath(["paplay", "pw-play", "aplay"]);
  if (!paplay) throw new Error("REMINDER_AUDIO_PLAYER_MISSING");
  return { command: paplay, args: [file] };
}

// 系统通知的显式播放：复用发音提供者，临时文件用完删除，不拉起采集/练习窗口。
async function playReminderAudio(
  pronunciation,
  word,
  { silent = false, platform = process.platform } = {},
) {
  const audio = await pronunciation.speak({ word });
  if (silent) return;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "leximeet-reminder-audio-"));
  try {
    const file = path.join(directory, "pronunciation.audio");
    await fs.writeFile(file, Buffer.from(audio.data, "base64"), { mode: 0o600 });
    const player = playerCommand(file, audio, platform);
    await promisify(execFile)(player.command, player.args, { timeout: 30000, windowsHide: true });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
module.exports = { playReminderAudio, playerCommand };
