import test from "node:test";
import assert from "node:assert/strict";
import { createPracticeAudio } from "../src/lib/practice-audio.js";
function fixture({ suspended = false } = {}) {
  const stats = {
    fetched: 0,
    decoded: 0,
    sources: [],
    filters: [],
    oscillators: [],
    closed: 0,
  };
  let resume;
  class Context {
    state = suspended ? "suspended" : "running";
    destination = {};
    currentTime = 0;
    decodeAudioData() {
      stats.decoded++;
      return Promise.resolve({ duration: 0.105 });
    }
    resume() {
      return new Promise((resolve) => {
        resume = resolve;
      });
    }
    close() {
      this.state = "closed";
      stats.closed++;
    }
    createGain() {
      return {
        gain: {
          value: 0,
          setValueAtTime() {},
          exponentialRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    }
    createBiquadFilter() {
      const node = { frequency: {}, Q: {}, connect() {}, disconnect() {} };
      stats.filters.push(node);
      return node;
    }
    createBufferSource() {
      const node = {
        playbackRate: {},
        connect() {},
        disconnect() {},
        start() {},
        stop() {
          this.onended?.();
        },
      };
      stats.sources.push(node);
      return node;
    }
    createOscillator() {
      const node = { frequency: {}, connect() {}, start() {}, stop() {} };
      stats.oscillators.push(node);
      return node;
    }
  }
  const audio = createPracticeAudio({
    AudioContextImpl: Context,
    fetchImpl: async () => {
      stats.fetched++;
      return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
    },
  });
  return { audio, stats, resume: () => resume() };
}
test("按键录音只加载解码一次；静音不创建音源，连打不过量叠音", async () => {
  const { audio, stats } = fixture();
  await audio.click(0);
  assert.equal(stats.fetched, 0);
  for (let i = 0; i < 8; i++) await audio.click(100);
  assert.equal(stats.fetched, 1);
  assert.equal(stats.decoded, 1);
  assert.equal(stats.oscillators.length, 0, "按键不再产生合成蜂鸣");
  assert.equal(stats.sources.length, 8);
  assert.ok(stats.filters.every((node) => node.type === "lowpass" && node.frequency.value <= 1000));
  assert.ok(stats.sources.every((node) => node.playbackRate.value < 1));
  audio.dispose();
  assert.equal(stats.closed, 1);
});
test("等待恢复音频期间关闭页面，不启动迟到的音源", async () => {
  const { audio, stats, resume } = fixture({ suspended: true });
  await audio.prepare();
  const pending = audio.click(60);
  await new Promise((resolve) => setImmediate(resolve));
  audio.dispose();
  resume();
  await pending;
  assert.equal(stats.sources.length, 0);
});
test("切题取消朗读，旧回调不覆盖新朗读；不支持朗读时明确失败", () => {
  const pending = [],
    errors = [];
  let cancelled = 0;
  const audio = createPracticeAudio({
    speech: { speak: (u) => pending.push(u), cancel: () => cancelled++ },
    Utterance: class {
      constructor(text) {
        this.text = text;
      }
    },
    onError: (message) => errors.push(message),
  });
  audio.speak("old", 40);
  audio.speak("new", 40);
  pending[0].onerror();
  assert.equal(errors.length, 0);
  pending[1].onerror();
  assert.equal(errors.length, 1);
  audio.dispose();
  assert.ok(cancelled >= 3);
  assert.throws(
    () => createPracticeAudio({ speech: null, Utterance: null }).speak("word", 60),
    /没有本机朗读/,
  );
});
