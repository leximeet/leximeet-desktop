import test from "node:test";
import assert from "node:assert/strict";
import { invoke } from "../src/lib/api.js";

test("桌面 Renderer 仅调用 preload 命名方法，不构造原始 IPC 请求", async () => {
  const original = globalThis.window;
  const payload = { action: "collect", word: "resilient", note: "阅读记录" };
  let observed;
  globalThis.window = {
    leximeet: {
      desktopCommand: async (value) => {
        observed = value;
        return { words: [value] };
      },
    },
  };
  try {
    const result = await invoke("desktopCommand", payload);
    assert.deepEqual(observed, payload);
    assert.deepEqual(result.words, [payload]);
    await assert.rejects(invoke("send", "unsafe-channel"), /不支持的操作/);
  } finally {
    globalThis.window = original;
  }
});

test("浏览器验收桥使用同源 POST，不在失联时创建浏览器本地词库", async () => {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch;
  globalThis.window = {};
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ words: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  try {
    assert.deepEqual(await invoke("snapshot"), { words: [] });
    assert.equal(request.url, "/__bridge/snapshot");
    assert.equal(request.options.method, "POST");
    assert.equal(request.options.body, "null");
    globalThis.fetch = async () =>
      new Response("<html>Vite</html>", {
        headers: { "Content-Type": "text/html" },
      });
    await assert.rejects(invoke("snapshot"), /尚未连接词遇本地核心/);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});

test("本地核心失败保留真实错误，不把冲突或服务失败伪装成成功", async () => {
  const originalWindow = globalThis.window,
    originalFetch = globalThis.fetch;
  globalThis.window = {};
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: { message: "备份记录 ID 冲突" } }), {
      status: 409,
      headers: { "Content-Type": "application/json" },
    });
  try {
    await assert.rejects(invoke("importData", {}), /备份记录 ID 冲突/);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
