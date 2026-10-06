const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { JavaRuntime } = require("../../electron/services/java-runtime.cjs");

const projectDir = path.resolve(__dirname, "../..");
const builtJar = path.join(projectDir, "core-java/target/leximeet-core.jar");

/**
 * 使用真实 fat jar 验证 Node -> 子进程 -> 回环 HTTP -> SQLite。
 * 每个用例创建独立临时目录，并追踪所有已启动子进程；即使回归导致管理器
 * 丢失 child 引用，清理阶段仍会结束本用例创建的进程，避免缓存与孤儿进程污染。
 */
function fixture(t, { jarPath = builtJar, Runtime = JavaRuntime, ...options } = {}) {
  assert.ok(fs.existsSync(jarPath), "请先运行 npm run build:core 生成 Java Core jar");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-runtime-e2e-"));
  // JDK 冷启动/首次原生库解压在 CI 上可能超过 5s；用生产级握手期限，不靠重试掩盖失败。
  const runtime = new Runtime({
    jarPath,
    dataDir: path.join(directory, "core"),
    timeout: 20000,
    ...options,
  });
  const children = new Set();
  function remember() {
    if (runtime.child) children.add(runtime.child);
  }
  async function start() {
    const starting = runtime.start();
    remember();
    try {
      return await starting;
    } finally {
      remember();
    }
  }
  t.after(async () => {
    remember();
    try {
      await runtime.stop();
    } finally {
      for (const child of children) await stopChild(child);
      // 仅删除本用例通过 mkdtemp 创建的目录，不接触正式用户目录。
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  return { runtime, directory, children, remember, start };
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

async function stopChild(child) {
  if (hasExited(child)) return;
  const closed = once(child, "close").catch(() => {});
  child.kill("SIGTERM");
  if (await Promise.race([closed.then(() => true), delay(1500).then(() => false)])) return;
  child.kill("SIGKILL");
  await Promise.race([closed, delay(1500)]);
}

async function stopRuntime(runtime) {
  const child = runtime.child;
  const exited = hasExited(child) ? Promise.resolve() : once(child, "close").catch(() => {});
  await runtime.stop();
  await Promise.race([
    exited,
    delay(2000).then(() => {
      throw new Error("Core 关闭后仍未退出");
    }),
  ]);
  assert.ok(hasExited(child), "stop 应结束它管理的 Java 子进程");
  assert.equal(runtime.port, null, "stop 后不保留旧端口");
}

async function raw(port, route, { token, body, method = "GET", headers = {} } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(4000),
  });
  return { response, body: await response.json() };
}

async function oversizedStatus(port, token) {
  // 只声明超限长度，不传送 2 MiB 内容，验证网关在读取正文前就拒绝。
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let received = "";
    socket.setTimeout(4000, () => {
      socket.destroy();
      reject(new Error("超限正文未及时拒绝"));
    });
    socket.once("error", reject);
    socket.once("connect", () =>
      socket.write(
        `POST /api/desktop/command HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${2 * 1024 * 1024 + 1}\r\nConnection: close\r\n\r\n`,
      ),
    );
    socket.on("data", (chunk) => {
      received += chunk.toString("utf8");
      if (received.includes("\r\n")) {
        socket.destroy();
        resolve(Number(received.split(" ")[1]));
      }
    });
  });
}

test(
  "Node 管理器真实启动：动态端口、当前令牌、无令牌拒绝和正文校验",
  { timeout: 45000 },
  async (t) => {
    const { runtime, start } = fixture(t);
    await start();
    assert.ok(Number.isInteger(runtime.port) && runtime.port > 0 && runtime.port <= 65535);
    assert.equal((await raw(runtime.port, "/health")).response.status, 401);
    assert.equal(
      (await raw(runtime.port, "/health", { token: "expired-token" })).response.status,
      401,
    );
    assert.deepEqual(await runtime.request("/health"), { ok: true, protocolVersion: "1" });
    assert.equal((await runtime.request("/api/snapshot")).words.length, 0);
    assert.equal(
      (
        await raw(runtime.port, "/api/snapshot", {
          token: runtime.token,
          headers: { Origin: "https://untrusted.example" },
        })
      ).response.status,
      403,
    );
    assert.equal(
      (
        await raw(runtime.port, "/api/desktop/command", {
          token: runtime.token,
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        })
      ).response.status,
      415,
    );
    assert.equal(
      (
        await raw(runtime.port, "/api/desktop/command", {
          token: runtime.token,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{invalid",
        })
      ).response.status,
      400,
    );
    assert.equal(await oversizedStatus(runtime.port, runtime.token), 413);
    await assert.rejects(
      runtime.request("/api/settings", "PATCH", { dataDir: "/tmp/not-allowed" }),
      /不支持的字段/,
    );
    await assert.rejects(
      runtime.request("/api/desktop/command", "POST", {
        action: "capture",
        word: "secure",
        context: "This secure source should not be accepted.",
        sourceUrl: "javascript:alert(1)",
      }),
      /来源链接/,
    );
    assert.equal(
      (await runtime.request("/api/snapshot")).words.length,
      0,
      "被拒绝的输入不能产生部分写入",
    );
  },
);

test("两个独立数据目录同时运行时端口不同且内容隔离", { timeout: 45000 }, async (t) => {
  const first = fixture(t);
  const second = fixture(t);
  await Promise.all([first.start(), second.start()]);
  assert.notEqual(first.runtime.port, second.runtime.port);
  assert.notEqual(first.runtime.token, second.runtime.token);
  await first.runtime.request("/api/desktop/command", "POST", {
    action: "collect",
    word: "isolated",
    note: "隔离资料",
  });
  assert.equal((await second.runtime.request("/api/snapshot")).words.length, 0);
  assert.equal(
    (await raw(first.runtime.port, "/health", { token: second.runtime.token })).response.status,
    401,
  );
});

// 本例连续经历三次 Java 启动；整体预算须覆盖各自 20s 握手及退出/请求。
// 生产握手期限与下方退出后 1s 内拒绝的断言保持，避免总期限先取消有效阶段。
test("同目录重复管理器启动失败，不影响已持有目录锁的原进程", { timeout: 90000 }, async (t) => {
  const first = fixture(t);
  await first.start();
  const duplicate = fixture(t, { dataDir: first.runtime.dataDir });
  const starting = duplicate.start();
  const child = duplicate.runtime.child;
  let exitedAt;
  child.once("exit", () => {
    exitedAt = Date.now();
  });
  // 验证的是退出后的及时拒绝，不把 JDK 冷启动、类加载和磁盘竞争当成生命周期错误。
  await assert.rejects(starting, (error) => {
    assert.match(error.message, /DATA_IN_USE/);
    assert.match(error.message, /另一应用使用/);
    assert.doesNotMatch(error.message, new RegExp(first.runtime.token));
    assert.doesNotMatch(error.message, /启动超时/);
    return true;
  });
  assert.ok(hasExited(child), "被目录锁拒绝的子进程必须确实退出");
  assert.ok(
    Number.isFinite(exitedAt) && Date.now() - exitedAt < 1000,
    "退出后必须立即反馈，不能等待启动超时",
  );
  assert.equal(duplicate.runtime.port, null);
  assert.deepEqual(await first.runtime.request("/health"), { ok: true, protocolVersion: "1" });
  // Core 对启动错误做了脱敏；用原进程退出后的真实重启证明冲突来自目录独占。
  await stopRuntime(first.runtime);
  await duplicate.start();
  assert.equal((await duplicate.runtime.request("/health")).ok, true);
});

test("start 并发和已启动后重复调用复用原子进程", { timeout: 45000 }, async (t) => {
  const fixtureValue = fixture(t);
  const { runtime, start, children, remember } = fixtureValue;
  const outcomes = await Promise.allSettled([start(), start()]);
  remember();
  assert.equal(
    outcomes.filter((value) => value.status === "rejected").length,
    0,
    outcomes
      .map((value) => value.reason?.message)
      .filter(Boolean)
      .join("; "),
  );
  const child = runtime.child;
  const port = runtime.port;
  const token = runtime.token;
  await start();
  assert.equal(runtime.child, child, "重复 start 不应覆盖子进程引用");
  assert.equal(runtime.port, port);
  assert.equal(runtime.token, token, "同一次启动不应更换配对令牌");
  assert.equal(children.size, 1, "并发请求应只创建一个子进程");
  assert.equal((await runtime.request("/health")).ok, true);
});

test(
  "stop 在启动握手前取消会立即结束 ready Promise，且允许后续重新启动",
  { timeout: 45000 },
  async (t) => {
    // 取消是否及时由下面独立的 1200ms 断言约束；后续重启仍使用生产级握手期限，
    // 避免把 CI 当时的 CPU 竞争误判为生命周期失败，也不通过重试掩盖真实错误。
    const { runtime, remember, start } = fixture(t);
    const starting = runtime.start();
    remember();
    const outcome = starting.then(
      () => ({ resolved: true }),
      (error) => ({ error }),
    );
    await runtime.stop();
    const result = await Promise.race([outcome, delay(1200).then(() => ({ pending: true }))]);
    assert.equal(result.pending, undefined, "stop 必须立即结束启动 Promise，不能悬挂到启动超时");
    assert.ok(result.error instanceof Error, "被关闭的启动应明确拒绝");
    assert.equal(runtime.port, null);
    await start();
    assert.equal((await runtime.request("/health")).ok, true);
  },
);

test(
  "正常关闭并重启同一管理器：个人数据持久化、令牌轮换和旧令牌拒绝",
  { timeout: 45000 },
  async (t) => {
    const { runtime, start } = fixture(t);
    await start();
    const previousToken = runtime.token;
    await runtime.request("/api/desktop/command", "POST", {
      action: "capture",
      word: "persist",
      note: "持久化笔记",
      context: "Persist the saved context.",
    });
    const first = await runtime.request("/api/desktop/query", "POST", {
      kind: "detail",
      wordId: "persist",
    });
    await stopRuntime(runtime);
    await assert.rejects(runtime.request("/api/snapshot"), /未连接|未启动|重新启动/);
    await start();
    assert.notEqual(runtime.token, previousToken, "每次真正启动都要换新令牌");
    assert.equal(
      (await raw(runtime.port, "/health", { token: previousToken })).response.status,
      401,
    );
    const restored = await runtime.request("/api/snapshot");
    assert.equal(restored.words[0].id, first.id);
    assert.equal(restored.words[0].note, "持久化笔记");
    assert.equal(restored.encounters[0].context, "Persist the saved context.");
  },
);

test("Java 意外被 kill 后立即失效旧连接，并可重新启动恢复数据库", { timeout: 45000 }, async (t) => {
  const { runtime, start } = fixture(t);
  await start();
  await runtime.request("/api/desktop/command", "POST", {
    action: "collect",
    word: "recover",
    note: "恢复后仍可读",
  });
  const previousToken = runtime.token;
  const child = runtime.child;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  assert.equal(runtime.port, null);
  await assert.rejects(runtime.request("/api/snapshot"), /未连接|未启动|重新启动/);
  await start();
  assert.notEqual(runtime.token, previousToken);
  assert.equal((await runtime.request("/api/snapshot")).words[0].word, "recover");
});

test("健康握手失败时结束已经成功创建的真实 Java 子进程", { timeout: 45000 }, async (t) => {
  class FailingHealthRuntime extends JavaRuntime {
    async request(route, ...args) {
      const response = await super.request(route, ...args);
      if (route === "/health") throw new Error("测试注入：健康握手读取失败");
      return response;
    }
  }
  const { runtime, start, children } = fixture(t, { Runtime: FailingHealthRuntime });
  await assert.rejects(start(), /健康握手读取失败/);
  assert.equal(runtime.port, null, "失败握手不能保留可用端口");
  assert.ok([...children].every(hasExited), "start 拒绝后不得遗留 Java 进程");
});

test("源 jar 被下一次构建覆盖后，已启动进程仍使用自己的运行快照", { timeout: 45000 }, async (t) => {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-jar-source-e2e-"));
  t.after(() => fs.rmSync(sourceDirectory, { recursive: true, force: true }));
  const sourceJar = path.join(sourceDirectory, "leximeet-core.jar");
  fs.copyFileSync(builtJar, sourceJar);
  const { runtime, start } = fixture(t, { jarPath: sourceJar });
  await start();
  fs.writeFileSync(sourceJar, "模拟构建工具覆盖源产物，当前进程不应继续读取此文件");
  await runtime.request("/api/desktop/command", "POST", {
    action: "capture",
    word: "snapshot",
    context: "The running process keeps its own snapshot.",
  });
  const snapshot = await runtime.request("/api/snapshot");
  assert.equal(snapshot.words[0].word, "snapshot");
  assert.equal(snapshot.encounters.length, 1);
  const backup = await runtime.request("/api/export");
  assert.equal(backup.format, "leximeet-backup");
  assert.equal(backup.version, 100);
  assert.equal(backup.schemaVersion, 100);
  assert.equal(backup.encoding, "sqlite-base64");
  assert.equal(Buffer.from(backup.data, "base64").subarray(0, 16).toString(), "SQLite format 3\0");
});
