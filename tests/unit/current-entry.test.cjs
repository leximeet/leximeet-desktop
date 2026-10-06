"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { METHODS } = require("../../electron/services/bridge.cjs");
const root = path.resolve(__dirname, "../..");

// 正式入口闭包只遍历生产源码，不以测试引用为旧页面保留理由。
test("所有前端代码均可由正式 main 入口到达，已退休页面不再进入源码树", () => {
  const source = path.join(root, "frontend/src");
  const code = (file) => /\.(?:vue|js|css)$/.test(file);
  function list(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).flatMap((item) => {
      const file = path.join(directory, item.name);
      return item.isDirectory() ? list(file) : code(file) ? [file] : [];
    });
  }
  const pending = [path.join(source, "main.js")];
  const reached = new Set();
  const imports =
    /(?:import\s+(?:[^;\n]*?\s+from\s*)?|export\s+[^;\n]*?\s+from\s*|import\s*\()(['"])(\.[^'"]+)\1/g;
  while (pending.length) {
    const file = pending.pop();
    if (reached.has(file)) continue;
    reached.add(file);
    for (const match of fs.readFileSync(file, "utf8").matchAll(imports)) {
      const dependency = path.resolve(path.dirname(file), match[2]);
      if (!code(dependency)) continue;
      assert.ok(fs.existsSync(dependency), `生产引用缺失：${path.relative(root, dependency)}`);
      pending.push(dependency);
    }
  }
  const unused = list(source).filter((file) => !reached.has(file));
  assert.deepEqual(
    unused.map((file) => path.relative(source, file)),
    [],
  );
});

test("Renderer、沙箱 preload 与 Main 暴露相同业务合同，旧实验接口不能只在一层遗留", () => {
  const frontend = fs.readFileSync(path.join(root, "frontend/src/lib/api.js"), "utf8");
  const frontContext = {};
  vm.runInNewContext(
    frontend.replace(/\bexport\s/g, "") + "\nglobalThis.methods = [...METHODS];",
    frontContext,
  );
  let nativeApi;
  vm.runInNewContext(fs.readFileSync(path.join(root, "electron/preload/bridge.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: {
          exposeInMainWorld(_name, api) {
            nativeApi = api;
          },
        },
        ipcRenderer: {
          invoke() {
            throw new Error("读取合同不应触发 IPC");
          },
        },
      };
    },
  });
  const expected = [...METHODS].sort();
  assert.deepEqual(Array.from(frontContext.methods).sort(), expected);
  assert.deepEqual(
    Object.keys(nativeApi)
      .filter((name) => !name.startsWith("on"))
      .sort(),
    expected,
  );
  for (const name of [
    "lookup",
    "translate",
    "todayQueue",
    "metrics",
    "previewVocabulary",
    "importVocabulary",
    "exportVocabulary",
    "clearTranslationCache",
    "saveWord",
    "updateWord",
    "createBook",
    "deleteBook",
    "createTag",
    "updateTag",
    "deleteTag",
    "trashWord",
    "restoreWord",
  ])
    assert.equal(expected.includes(name), false, `已退休动作不能重新开放：${name}`);
});
