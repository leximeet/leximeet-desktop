import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [vue()],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // 音频保留为随包文件；Web Audio 缓存解码，不放宽桌面 connect-src 安全策略。
    assetsInlineLimit: (file) => (file.endsWith(".mp3") ? false : undefined),
  },
});
