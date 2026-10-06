import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import { invoke } from "../src/lib/api.js";

test("原生桌面接口把嵌套 Vue 响应式数据转换为可传输 JSON", async () => {
  const payload = reactive({
    action: "saveNote",
    wordId: "example",
    note: "自己的笔记",
    bookIds: ["book-a"],
    expectedRevision: 0,
  });
  const prior = globalThis.window;
  globalThis.window = {
    leximeet: {
      desktopCommand(data) {
        // Electron 的 structured clone 不接受 Proxy；真实结构克隆确保没有浏览器 JSON 回退掩盖问题。
        return structuredClone(data);
      },
    },
  };
  try {
    assert.deepEqual(await invoke("desktopCommand", payload), JSON.parse(JSON.stringify(payload)));
  } finally {
    globalThis.window = prior;
  }
});
