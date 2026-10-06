import { ref, onBeforeUnmount } from "vue";
import { api } from "../lib/api.js";
import { createWorkspaceController } from "./workspace-controller.js";

// Renderer 只发用例意图。状态来自 Core，UI 草稿单独持有，失败和迟到响应不能覆盖新草稿。
export function useDesktop() {
  const state = ref(null),
    runtime = ref(null),
    busy = ref(false),
    error = ref(""),
    notice = ref(""),
    loading = ref(true);
  const audio = ref({ state: "idle", word: "" }),
    audioSettings = ref(null);
  let disposed = false,
    audioSequence = 0,
    player,
    objectUrl;
  const fields = { state, runtime, busy, error, notice, loading };
  const workspace = createWorkspaceController({
    api,
    publish: (patch) => {
      for (const [name, value] of Object.entries(patch)) fields[name].value = value;
    },
  });
  const { command, settings, native, practiceFeedback } = workspace;
  async function refresh() {
    const success = await workspace.refresh();
    if (success && !audioSettings.value) {
      try {
        const config = await api.audioSettings({ action: "get" });
        if (!disposed) audioSettings.value = config;
      } catch (failure) {
        if (!disposed) error.value = failure.message;
      }
    }
    return success;
  }
  function stopAudio() {
    audioSequence++;
    player?.pause();
    player = null;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    audio.value = { state: "idle", word: "" };
    api.pronounce({ action: "cancel" }).catch(() => {});
  }
  async function speak(word, accent, practice = {}) {
    stopAudio();
    const sequence = audioSequence;
    const cue = { ...practice, word, cue: sequence };
    audio.value = { ...cue, state: "loading" };
    try {
      const result = await api.pronounce({
        word,
        ...(accent ? { accent } : {}),
      });
      if (sequence !== audioSequence) return;
      const bytes = Uint8Array.from(atob(result.data), (symbol) => symbol.charCodeAt(0));
      objectUrl = URL.createObjectURL(new Blob([bytes], { type: result.mime }));
      player = new Audio(objectUrl);
      player.playbackRate = result.rate;
      player.volume = result.volume;
      player.onended = async () => {
        if (sequence !== audioSequence) return;
        // 只有当前音频自然结束才提交教学完成；拿到文件或 play() 成功都不算完成。
        audio.value = { ...cue, state: "completing" };
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
        player = null;
        try {
          await api.pronounce({
            action: "completed",
            playbackId: result.playbackId,
          });
          if (sequence !== audioSequence) return;
          audio.value = { ...cue, state: "idle" };
          await refresh();
        } catch (failure) {
          if (sequence === audioSequence) {
            audio.value = { ...cue, state: "failed" };
            error.value = failure.message;
          }
        }
      };
      player.onerror = () => {
        if (sequence === audioSequence) {
          audio.value = { ...cue, state: "failed" };
          error.value = "音频无法播放，请更换提供者或重试";
        }
      };
      await player.play();
      if (sequence === audioSequence)
        audio.value = { ...cue, state: "playing", provider: result.provider };
    } catch (failure) {
      if (sequence === audioSequence) {
        audio.value = { ...cue, state: "failed" };
        error.value = failure.message;
      }
    }
  }
  onBeforeUnmount(() => {
    disposed = true;
    workspace.dispose();
    stopAudio();
  });
  return {
    state,
    runtime,
    busy,
    error,
    notice,
    loading,
    audio,
    audioSettings,
    refresh,
    command,
    practiceFeedback,
    native,
    settings,
    speak,
    stopAudio,
  };
}
