// 练习音频：本机 Web Audio 提示音与 speechSynthesis。关闭页面必须 dispose。

export function createPracticeAudio({
  speech = globalThis.speechSynthesis,
  Utterance = globalThis.SpeechSynthesisUtterance,
  AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext,
  fetchImpl = globalThis.fetch,
  onError = () => {},
} = {}) {
  let context = null;
  let utterance = null;
  let keyBuffer = null;
  const keySources = new Set();
  // 代次绑定到具体一次朗读或振荡器；旧回调不能在切题、dispose 之后改写新题。
  let speechGeneration = 0;
  let audioGeneration = 0;

  function volumeGain(percent) {
    const n = Number(percent);
    if (!Number.isFinite(n)) return 0.6;
    return Math.min(1, Math.max(0, n / 100));
  }

  function ensureContext() {
    if (!AudioContextImpl) throw new Error("当前环境没有 Web Audio");
    if (!context || context.state === "closed") context = new AudioContextImpl();
    return context;
  }

  async function playTone({ frequency, type, duration, attack, volume, scale }) {
    const level = volumeGain(volume) * scale;
    // 音量 0 必须真正静音。exponentialRamp 不能落到 0，所以直接不启动振荡器。
    if (level <= 0) return;
    const audio = ensureContext();
    const generation = audioGeneration;
    if (audio.state === "suspended") await audio.resume();
    if (generation !== audioGeneration || context !== audio || audio.state === "closed") return;
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    const now = audio.currentTime;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.01);
  }

  function prepare() {
    const audio = ensureContext();
    // 随包的 Topre 录音只解码一次，连打直接复用内存，不依赖网络或合成蜂鸣。
    keyBuffer ||= fetchImpl(new URL("../assets/audio/keyboard-thock.mp3", import.meta.url))
      .then((response) => {
        if (!response.ok) throw new Error("按键音加载失败");
        return response.arrayBuffer();
      })
      .then((bytes) => audio.decodeAudioData(bytes))
      .catch((error) => {
        keyBuffer = null;
        throw error;
      });
    return keyBuffer;
  }

  async function click(volume) {
    const level = volumeGain(volume) * 0.55;
    if (level <= 0) return;
    const audio = ensureContext(),
      generation = audioGeneration;
    const buffer = await prepare();
    if (audio.state === "suspended") await audio.resume();
    if (generation !== audioGeneration || context !== audio || audio.state === "closed") return;
    const source = audio.createBufferSource(),
      filter = audio.createBiquadFilter(),
      gain = audio.createGain();
    source.buffer = buffer;
    source.playbackRate.value = 0.85;
    // 保留键帽触底的低频冲击，压低金属尖响；最多四个短音，避免快速输入堆响。
    filter.type = "lowpass";
    filter.frequency.value = 900;
    filter.Q.value = 0.5;
    gain.gain.value = level;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(audio.destination);
    source.onended = () => {
      keySources.delete(source);
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
    if (keySources.size >= 4) [...keySources][0].stop();
    keySources.add(source);
    source.start();
  }

  function tone(ok, volume) {
    return playTone({
      frequency: ok ? 390 : 180,
      type: "sine",
      duration: 0.12,
      attack: 0.01,
      volume,
      scale: 0.09,
    });
  }

  function cancelSpeech() {
    speechGeneration += 1;
    try {
      speech?.cancel?.();
    } catch {
      // 取消失败不阻止切题
    }
    utterance = null;
  }

  function speak(text, volume) {
    if (!speech || typeof Utterance !== "function") throw new Error("当前环境没有本机朗读");
    cancelSpeech();
    const generation = speechGeneration;
    const current = new Utterance(text);
    current.lang = "en-US";
    current.volume = volumeGain(volume);
    current.onerror = () => {
      if (generation !== speechGeneration) return;
      onError("本机朗读失败或被系统中止");
    };
    utterance = current;
    speech.speak(current);
  }

  function dispose() {
    audioGeneration += 1;
    for (const source of keySources) source.stop();
    keySources.clear();
    keyBuffer = null;
    cancelSpeech();
    if (context) {
      const closing = context;
      context = null;
      void closing.close?.();
    }
  }

  return { prepare, click, tone, speak, cancelSpeech, dispose };
}
