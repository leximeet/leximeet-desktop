"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  playerCommand,
  reminderAudioFileName,
} = require("../../electron/services/reminder-audio.cjs");

test("Windows WAV 走 SoundPlayer，MP3 走 WPF MediaPlayer", () => {
  const wav = playerCommand("C:\\tmp\\pronunciation.wav", { mime: "audio/wav" }, "win32");
  assert.match(wav.args.at(-1), /SoundPlayer/);
  assert.doesNotMatch(wav.args.at(-1), /MediaPlayer/);
  const mp3 = playerCommand(
    "C:\\tmp\\pronunciation.mp3",
    { mime: "audio/mpeg", volume: 0.5 },
    "win32",
  );
  assert.match(mp3.args.at(-1), /MediaPlayer/);
  assert.match(mp3.args.at(-1), /presentationCore/);
  assert.doesNotMatch(mp3.args.at(-1), /SoundPlayer/);
  assert.equal(reminderAudioFileName("audio/wav"), "pronunciation.wav");
  assert.equal(reminderAudioFileName("audio/mpeg"), "pronunciation.mp3");
});
