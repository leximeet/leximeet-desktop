"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createBridge, METHODS, safeExternalUrl } = require("../../electron/services/bridge.cjs");
const { resolveProfile } = require("../../electron/services/profiles.cjs");
const { javaExecutable } = require("../../electron/services/java-runtime.cjs");

function fixture() {
  const requests = [];
  const external = [];
  const bridge = createBridge({
    core: {
      token: "private-token-never-exposed",
      port: 43123,
      request: async (...args) => {
        requests.push(args);
        return { ok: true };
      },
    },
    profile: {
      name: "test",
      root: "/isolated/test",
      coreDir: "/isolated/test/core",
    },
    openExternal: async (url) => external.push(url),
    versions: { node: process.versions.node },
  });
  return { bridge, requests, external };
}

test("桥仅开放明确业务方法，不提供通用 IPC、HTTP 或任意命令能力", async () => {
  const { bridge } = fixture();
  assert.deepEqual(Object.keys(bridge).sort(), [...METHODS].sort());
  assert.equal(new Set(METHODS).size, METHODS.length);
  assert.ok(Object.isFrozen(METHODS));
  for (const name of ["request", "invoke", "send", "exec", "readFile", "fetch", "token", "port"])
    assert.equal(bridge[name], undefined);
  const runtime = bridge.runtime();
  assert.equal(runtime.coreConnected, true);
  assert.equal(runtime.profile, "test");
  assert.ok(!JSON.stringify(runtime).includes("private-token"));
  assert.ok(!JSON.stringify(runtime).includes("43123"));
});

test("当前规划与练习只通过桌面命名用例，不开放旧评分和旧计划通道", async () => {
  const { bridge, requests } = fixture();
  for (const method of [
    "proficiency",
    "markProficiency",
    "undoProficiency",
    "previewPlan",
    "savePlan",
    "review",
    "undoReview",
    "todayQueue",
    "previewVocabulary",
    "importVocabulary",
    "exportVocabulary",
    "metrics",
    "lookup",
    "translate",
    "clearTranslationCache",
    "replaceDictionary",
  ]) {
    assert.equal(METHODS.includes(method), false);
    assert.equal(bridge[method], undefined);
  }
  const command = {
    action: "planningSave",
    goal: "book:qwerty:IELTS_3_T",
    dailyNew: 10,
    dailyReview: 20,
  };
  await bridge.desktopCommand(command);
  assert.deepEqual(requests, [["/api/desktop/command", "POST", command]]);
});

test("公共查词只使用现行词典服务，构造桥不读取旧 ECDICT 或发起网络请求", async () => {
  const calls = [];
  const bridge = createBridge({
    core: {
      port: 1,
      request() {
        throw new Error("词典动作不能旁路 Core HTTP");
      },
    },
    profile: { name: "test", root: "/missing-test-profile", coreDir: "/missing-test-profile/core" },
    textDictionary: {
      action(data) {
        calls.push(data);
        return { lemma: "hello" };
      },
    },
  });
  assert.equal(bridge.runtime().dictionary, "leximeet-dictionary 0.0.3");
  assert.deepEqual(await bridge.dictionaryAction({ action: "lookup", word: "hello" }), {
    lemma: "hello",
  });
  assert.deepEqual(calls, [{ action: "lookup", word: "hello" }]);
  assert.throws(
    () => fixture().bridge.dictionaryAction({ action: "lookup", word: "hello" }),
    /尚未装配公共词典/,
  );
});

test("资料变更只进入固定桌面命令端点，记录 ID 不参与拼接 HTTP 路径", async () => {
  const { bridge, requests } = fixture();
  const payload = {
    action: "saveNote",
    wordId: "../settings?unexpected=1",
    note: "由核心校验完整业务命令",
    bookIds: [],
  };
  await bridge.desktopCommand(payload);
  assert.deepEqual(requests, [["/api/desktop/command", "POST", payload]]);
  // 旧基础 CRUD 在 Main 中也不存在，不能绕过当前命令与领域验证。
  for (const name of [
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
    assert.equal(bridge[name], undefined);
});

test("外链仅允许无凭证 HTTP/HTTPS，禁止脚本/文件/自定义协议", async () => {
  const { bridge, external } = fixture();
  for (const url of [
    "javascript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,hi",
    "mailto:x@example.com",
    "vscode://file/test",
    "https://name:password@example.com/",
    "relative/path",
    "https://" + "x".repeat(4096),
    null,
  ]) {
    assert.throws(() => bridge.openExternal(url));
  }
  assert.deepEqual(external, []);
  await bridge.openExternal("https://example.com/词遇?word=hello");
  assert.equal(external.length, 1);
  assert.equal(external[0], safeExternalUrl("https://example.com/词遇?word=hello"));
});

test("预览与一次性验收每次创建独立目录，含独立 Core/Chromium 子目录", (t) => {
  const created = [];
  t.after(() => created.forEach((root) => fs.rmSync(root, { recursive: true, force: true })));
  const first = resolveProfile({ name: "test" });
  created.push(first.root);
  const second = resolveProfile({ name: "test" });
  created.push(second.root);
  assert.notEqual(first.root, second.root);
  for (const profile of [first, second]) {
    assert.equal(profile.ephemeral, true);
    assert.ok(profile.root.startsWith(os.tmpdir()));
    assert.ok(fs.statSync(profile.coreDir).isDirectory());
    assert.ok(fs.statSync(profile.sessionDir).isDirectory());
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(profile.root, "profile.json"))).profile,
      "test",
    );
  }
});

test("已标记数据目录不能跨 profile 打开，开发目录和正式目录分离", (t) => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-profile-unit-"));
  t.after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
  const userData = path.join(sandbox, "formal-profile");
  const formal = resolveProfile({ name: "local", userData });
  const development = resolveProfile({ name: "dev", projectDir: sandbox });
  assert.notEqual(formal.root, development.root);
  assert.equal(formal.ephemeral, false);
  assert.equal(development.root, path.join(sandbox, ".runtime/dev-v1"));
  assert.throws(() => resolveProfile({ name: "test", dataDir: formal.root }), /拒绝以 test 打开/);
  assert.throws(() => resolveProfile({ name: "test", dataDir: "./relative" }), /绝对路径/);
  assert.throws(() => resolveProfile({ name: "unknown" }), /未知运行环境/);
  assert.ok(fs.statSync(formal.coreDir).isDirectory());
});

test("Java 定位遵从显式路径和 JAVA_HOME，不构建 shell 命令", () => {
  assert.equal(
    javaExecutable({
      LEXIMEET_JAVA: "/tmp/java-custom",
      JAVA_HOME: "/ignored",
    }),
    "/tmp/java-custom",
  );
  assert.equal(
    javaExecutable({ JAVA_HOME: "/tmp/java home" }),
    path.join("/tmp/java home", "bin", process.platform === "win32" ? "java.exe" : "java"),
  );
  assert.equal(javaExecutable({}), "java");
});
