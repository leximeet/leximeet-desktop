"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { generateKeyPairSync, createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { spawn, spawnSync } = require("node:child_process");
const { once } = require("node:events");
const gate = require("../../scripts/lib/connected-readiness.cjs");
const launcher = require("../../scripts/accept-connected.cjs");
const cli = require("../../scripts/lib/connected-cli-worker.cjs");
const currentSuite = require("../connected/run-browser.cjs");
const { connectedSessionRoot } = require("../../scripts/lib/connected-session-path.cjs");
const cliFixture = path.resolve(__dirname, "../connected/fixtures/cli-worker.cjs");
const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 1024 });
const key = publicKey.export({ type: "spki", format: "der" }).toString("base64");

test("当前联调门禁必须九场全通过，旧八场、跳过、重试成功或字节变化均拒绝", () => {
  const record = {
    exitCode: 0,
    interrupted: null,
    testsUnchanged: true,
    productionBytesUnchanged: true,
  };
  const stats = { expected: 9, unexpected: 0, skipped: 0, flaky: 0 };
  assert.equal(currentSuite.passesCurrentSuite(record, stats), true);
  assert.deepEqual(currentSuite.SCENARIO_GROUPS, { connectionAndCapture: 7, readingUi: 2 });
  for (const change of [
    { expected: 8 },
    { expected: 10 },
    { unexpected: 1 },
    { skipped: 1 },
    { flaky: 1 },
  ])
    assert.equal(currentSuite.passesCurrentSuite(record, { ...stats, ...change }), false);
  for (const change of [
    { exitCode: 1 },
    { interrupted: "SIGINT" },
    { testsUnchanged: false },
    { productionBytesUnchanged: false },
  ])
    assert.equal(currentSuite.passesCurrentSuite({ ...record, ...change }, stats), false);
  assert.equal(currentSuite.passesCurrentSuite(record, undefined), false);
});

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-readiness-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = {
    manifest_version: 3,
    version: "1.0.0",
    version_name: "1.0.0-dev.2",
    key,
    permissions: [...gate.REQUIRED_PERMISSIONS],
    background: { service_worker: "background.js" },
    options_ui: { page: "options.html", open_in_tab: true },
    side_panel: { default_path: "sidepanel.html" },
  };
  const declaration = {
    apiVersion: "1.0.0",
    nativeHost: gate.NATIVE_HOST,
    sourceCommit: "a".repeat(40),
    jointAcceptancePassed: false,
    contractVersion: gate.CONTRACT_VERSION,
    contractDigest: gate.CONTRACT_DIGEST,
  };
  const write = () => {
    fs.writeFileSync(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    fs.writeFileSync(path.join(directory, "lmcp-readiness.json"), JSON.stringify(declaration));
  };
  fs.writeFileSync(
    path.join(directory, "background.js"),
    "// fixed fixture, not a Browser implementation\n",
  );
  fs.writeFileSync(path.join(directory, "options.html"), "<!doctype html><title>fixture</title>\n");
  fs.writeFileSync(
    path.join(directory, "sidepanel.html"),
    "<!doctype html><title>fixture panel</title>\n",
  );
  write();
  return { directory, manifest, declaration, write };
}
const snapshot = (directory) =>
  fs
    .readdirSync(directory)
    .sort()
    .map((name) => {
      const file = path.join(directory, name);
      return [name, fs.statSync(file).mtimeMs, fs.readFileSync(file).toString("base64")];
    });

test("公开 key 的稳定 a-p ID 由 DER 摘要产生，路径改变不改变身份", (t) => {
  const f = fixture(t);
  const expected = createHash("sha256")
    .update(Buffer.from(key, "base64"))
    .digest("hex")
    .slice(0, 32)
    .replace(/[0-9a-f]/g, (x) => String.fromCharCode(97 + parseInt(x, 16)));
  assert.equal(gate.deriveExtensionId(key), expected);
  assert.match(expected, /^[a-p]{32}$/);
  const copy = path.join(f.directory, "copy");
  fs.mkdirSync(copy);
  for (const name of [
    "manifest.json",
    "lmcp-readiness.json",
    "background.js",
    "options.html",
    "sidepanel.html",
  ])
    fs.copyFileSync(path.join(f.directory, name), path.join(copy, name));
  assert.equal(gate.checkReadiness(copy).extensionId, expected);
  assert.equal(gate.checkReadiness(copy).evidenceKind, "build-declaration-only");
});

test("--check 成功只是只读声明，既不调用启动器也不改构建", async (t) => {
  const f = fixture(t);
  const before = snapshot(f.directory);
  let started = false;
  const result = await launcher.main(["--check", "--extension", f.directory], {
    start: () => {
      started = true;
    },
  });
  assert.equal(result.ready, true);
  assert.equal(started, false);
  assert.deepEqual(snapshot(f.directory), before);
});

test("真实旧版本构建门禁失败，不读取运行能力、不启动、不写目录", async (t) => {
  const f = fixture(t);
  f.manifest.version = "0.0.1";
  f.write();
  const before = snapshot(f.directory);
  let started = false;
  await assert.rejects(
    launcher.main(["--check", "--extension", f.directory], {
      start: () => {
        started = true;
      },
    }),
    /低于 1.0.0/,
  );
  assert.equal(started, false);
  assert.deepEqual(snapshot(f.directory), before);
});

test("rc.5 旧摘要不能作为当前 1.0.0 一键邀请的候选，不启动或改写构建", async (t) => {
  const f = fixture(t);
  f.declaration.contractVersion = "1.0.0-rc.5";
  f.declaration.contractDigest = "2d9e976d2b17741ee75a7e207aea3e1f1887b03f7ab23153e98815276f4a6a3a";
  f.write();
  const before = snapshot(f.directory);
  let started = false;
  await assert.rejects(
    launcher.main(["--check", "--extension", f.directory], {
      start: () => {
        started = true;
      },
    }),
    /1\.0\.0 契约版本或摘要不一致/,
  );
  assert.equal(started, false);
  assert.deepEqual(snapshot(f.directory), before);
});

test("CLI 拒绝旧版本夹具，不依赖当前 Browser 开发进度", (t) => {
  const f = fixture(t);
  f.manifest.version = "0.0.1";
  f.write();
  const before = snapshot(f.directory);
  const result = spawnSync(
    process.execPath,
    [
      path.resolve(__dirname, "../../scripts/accept-connected.cjs"),
      "--check",
      "--extension",
      f.directory,
    ],
    { encoding: "utf8", timeout: 10000 },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /低于 1.0.0|找不到 Browser 构建/);
  assert.deepEqual(snapshot(f.directory), before);
  assert.doesNotMatch(result.stdout, /已启动/);
});

for (const [label, change, pattern] of [
  [
    "Native 权限",
    (f) => {
      f.manifest.permissions = ["storage"];
    },
    /阅读采集权限/,
  ],
  [
    "完整契约摘要",
    (f) => {
      f.declaration.contractDigest = "0".repeat(64);
    },
    /摘要不一致/,
  ],
  [
    "契约候选版本",
    (f) => {
      f.declaration.contractVersion = "1.0.0-rc.3";
    },
    /版本或摘要不一致/,
  ],
  [
    "无效 key",
    (f) => {
      f.manifest.key = Buffer.from("not-der").toString("base64");
    },
    /SPKI/,
  ],
  [
    "API 版本",
    (f) => {
      f.declaration.apiVersion = "2.0.0";
    },
    /API 版本/,
  ],
  [
    "Host 名称",
    (f) => {
      f.declaration.nativeHost = "org.other.browser";
    },
    /Host 名称/,
  ],
  [
    "源码提交声明",
    (f) => {
      f.declaration.sourceCommit = "not-a-sha";
    },
    /源码提交/,
  ],
  [
    "验收状态声明",
    (f) => {
      delete f.declaration.jointAcceptancePassed;
    },
    /联合验收状态/,
  ],
  [
    "越界入口",
    (f) => {
      f.manifest.background.service_worker = "../background.js";
    },
    /有效的构建入口/,
  ],
])
  test(`缺少或伪造 ${label} 必须失败，不能启动降级模式`, async (t) => {
    const f = fixture(t);
    change(f);
    f.write();
    let started = false;
    await assert.rejects(
      launcher.main(["--check", "--extension", f.directory], {
        start: () => {
          started = true;
        },
      }),
      pattern,
    );
    assert.equal(started, false);
  });

test("生产构建没有公开 key 时不伪造身份，不要求 rc.4 的练习与原子导入能力", (t) => {
  const f = fixture(t);
  delete f.manifest.key;
  f.write();
  const before = snapshot(f.directory);
  const checked = gate.checkReadiness(f.directory);
  assert.equal(checked.extensionId, null);
  assert.equal(checked.nativeHost, "org.leximeet.browser");
  assert.equal(checked.evidenceKind, "build-declaration-only");
  assert.deepEqual(snapshot(f.directory), before);
});

test("生产副本逐文件校验能发现 bundle 变化，而不是只核对 manifest", (t) => {
  const f = fixture(t);
  const before = gate.checkReadiness(f.directory).productionHashes;
  fs.appendFileSync(path.join(f.directory, "background.js"), "// changed production byte\n");
  const after = gate.checkReadiness(f.directory).productionHashes;
  assert.notEqual(before["background.js"], after["background.js"]);
  assert.equal(before["manifest.json"], after["manifest.json"]);
});

test("随包运行清除宿主 Java/Node 配置且后台标记不能丢失", () => {
  const current = launcher.cleanEnvironment("/private/tmp/leximeet-test", {
    headless: true,
  });
  assert.equal(current.JAVA_HOME, undefined);
  assert.equal(current.LEXIMEET_JAVA, undefined);
  assert.equal(current.NODE_OPTIONS, undefined);
  assert.equal(current.LEXIMEET_PROFILE, "test");
  assert.equal(current.LEXIMEET_TEST_SILENT, "1");
  assert.equal(current.LEXIMEET_SEED_DEMO, "0");
  assert.equal(current.PATH, "/usr/bin:/bin:/usr/sbin:/sbin");
});

test("首次下载先直连，不继承失效代理，成功后不重试且保留浏览器缓存路径", async () => {
  const calls = [];
  const value = await launcher.withDownloadFallback(
    async ({ attempt, env }) => {
      calls.push(attempt);
      assert.equal(env.http_proxy, undefined);
      assert.equal(env.HTTPS_PROXY, undefined);
      assert.equal(env.npm_config_proxy, undefined);
      assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, "/private/tmp/owned-browser-cache");
      return "ready";
    },
    {
      env: {
        http_proxy: "http://unavailable",
        HTTPS_PROXY: "http://unavailable",
        npm_config_proxy: "http://unavailable",
        PLAYWRIGHT_BROWSERS_PATH: "/private/tmp/owned-browser-cache",
      },
    },
  );
  assert.equal(value, "ready");
  assert.deepEqual(calls, [1]);
});

test("Chromium 与依赖下载失败按直连、7897、12334 重试，不混入上一套代理", async () => {
  const calls = [];
  await launcher.withDownloadFallback(
    async ({ attempt, env }) => {
      calls.push([env.https_proxy, env.all_proxy]);
      if (attempt < 3) throw new Error("network unavailable");
    },
    { env: {} },
  );
  assert.deepEqual(calls, [
    [undefined, undefined],
    ["http://127.0.0.1:7897", "socks5://127.0.0.1:7897"],
    ["http://127.0.0.1:12334", "socks5://127.0.0.1:12334"],
  ]);
});

test("三套网络均失败保留最后真实错误，不伪报准备成功", async () => {
  let attempts = 0;
  const failure = new Error("last failure");
  await assert.rejects(
    launcher.withDownloadFallback(
      async () => {
        attempts += 1;
        throw failure;
      },
      { env: {} },
    ),
    (error) => error === failure,
  );
  assert.equal(attempts, 3);
});

test("下载过程中 Ctrl+C 取消立即退出，不继续启动后备下载", async () => {
  let attempts = 0,
    cancelled = false;
  const cancellation = new Error("cancelled");
  await assert.rejects(
    launcher.withDownloadFallback(
      async () => {
        attempts += 1;
        cancelled = true;
        throw new Error("download interrupted");
      },
      {
        env: {},
        active() {
          if (cancelled) throw cancellation;
        },
      },
    ),
    (error) => error === cancellation,
  );
  assert.equal(attempts, 1);
});

// 真实就绪条件的生命周期夹具；不提供 click，驱动不能替用户跳过。
function renderFixture(guide) {
  const rendered = new EventEmitter(),
    calls = [];
  const state = {
    pending: false,
    main: false,
    card: false,
    inert: false,
    skipVisible: true,
    skipEnabled: true,
    staleOverlay: false,
  };
  let elapsed = 0,
    sleeping;
  const card = {
    count: async () => (state.card ? 1 : 0),
    isVisible: async () => state.card,
    evaluate: async () => {
      calls.push("inert");
      return state.inert;
    },
    getByRole: (role, options) => {
      calls.push(`${role}:${options.name}`);
      return {
        isVisible: async () => state.skipVisible,
        isEnabled: async () => state.skipEnabled,
      };
    },
  };
  const main = {
    count: async () => 1,
    isVisible: async () => state.main,
  };
  return {
    calls,
    state,
    options: {
      now: () => elapsed,
      sleep: (ms) => {
        elapsed += ms;
        return new Promise((resolve) => {
          sleeping = resolve;
          rendered.emit("waiting");
        });
      },
    },
    nextPoll: () => (sleeping ? Promise.resolve() : once(rendered, "waiting")),
    tick: () => {
      const resolve = sleeping;
      sleeping = null;
      resolve();
    },
    page: {
      evaluate: async () => (state.pending ? { pending: true } : { guide }),
      locator: (selector) => {
        calls.push(selector);
        if (selector === ".d-main .d-page") return { first: () => main };
        if (selector === '.guide-coach[role="dialog"]') return card;
        return { count: async () => (state.staleOverlay ? 1 : 0) };
      },
      getByRole: (role, options) => {
        calls.push(`${role}:${options.name}`);
        return card;
      },
    },
  };
}
test("资料先到、欢迎卡后显示时必须等真实绘制，不自动跳过教学", async () => {
  const f = renderFixture({ active: true, started: false });
  let done = false;
  const ready = launcher
    .waitDesktopRendered(f.page, { ...f.options, timeoutMs: 7000 })
    .then((value) => {
      done = true;
      return value;
    });
  await f.nextPoll();
  assert.equal(done, false);
  f.state.main = true;
  f.tick();
  await f.nextPoll();
  assert.equal(done, false);
  assert.ok(f.calls.includes("dialog:欢迎使用词遇"));
  f.state.card = true;
  f.tick();
  assert.deepEqual(await ready, {
    mainRendered: true,
    accessible: true,
    guide: "invitation",
  });
});
test("已结束引导只等待真实主内容，继续教学则等待批注卡", async () => {
  for (const [guide, expected, overlay] of [
    [{ active: false, started: false }, "inactive", false],
    [{ active: true, started: true }, "teaching", true],
  ]) {
    const f = renderFixture(guide);
    f.state.main = true;
    f.state.card = overlay;
    const ready = launcher.waitDesktopRendered(f.page, f.options);
    assert.equal((await ready).guide, expected);
    assert.equal(f.calls.includes("dialog:欢迎使用词遇"), false);
  }
});
test("可见邀请仍 inert 或跳过按钮未启用时继续等，不能把存在当可交互", async () => {
  const f = renderFixture({ active: true, started: false });
  Object.assign(f.state, { main: true, card: true, inert: true });
  let done = false;
  const ready = launcher.waitDesktopRendered(f.page, f.options).then(() => {
    done = true;
  });
  await f.nextPoll();
  assert.equal(done, false);
  Object.assign(f.state, { inert: false, skipEnabled: false });
  f.tick();
  await f.nextPoll();
  assert.equal(done, false);
  f.state.skipEnabled = true;
  f.tick();
  await ready;
  assert.equal(done, true);
  assert.ok(f.calls.includes("inert"));
  assert.ok(f.calls.includes("button:跳过教学"));
});
test("Core尚未在线或旧遮罩未撤回时等候，两端复核不能重置截止时间", async () => {
  const f = renderFixture({ active: false, started: false });
  Object.assign(f.state, { pending: true, main: true });
  const ready = launcher.waitDesktopRendered(f.page, {
    ...f.options,
    deadline: 250,
  });
  const rejected = assert.rejects(ready, /尚未就绪/);
  await f.nextPoll();
  Object.assign(f.state, { pending: false, staleOverlay: true });
  f.tick();
  await f.nextPoll();
  f.tick();
  await f.nextPoll();
  f.tick();
  await rejected;
  assert.equal(f.options.now(), 250);
  await assert.rejects(
    launcher.waitDesktopRendered(f.page, { ...f.options, deadline: 250 }),
    /尚未就绪/,
  );
});
test("缺失实际引导快照即失败，不能把Core在线当作UI就绪", async () => {
  for (const state of [null, {}, { guide: null }])
    await assert.rejects(
      launcher.waitDesktopRendered({ evaluate: async () => state }),
      /快照不完整/,
    );
});

test("外站导航完成后重新核验当前Core与可访问教学，旧就绪结果不能交付且不重启等待", async () => {
  const f = renderFixture({ active: true, started: false });
  Object.assign(f.state, { main: true, card: true });
  assert.equal((await launcher.waitDesktopRendered(f.page, f.options)).accessible, true);
  const options = {
    ...f.options,
    sleep: () => {
      throw new Error("交付核验不得重新轮询启动预算");
    },
  };
  // 模拟外站导航期间 Core 下线；不能复用导航前的成功快照。
  f.state.pending = true;
  await assert.rejects(launcher.verifyDesktopHandoff(f.page, options), /尚未就绪/);
  Object.assign(f.state, { pending: false, inert: true });
  await assert.rejects(launcher.verifyDesktopHandoff(f.page, options), /尚未就绪/);
  Object.assign(f.state, { inert: false, skipEnabled: false });
  await assert.rejects(launcher.verifyDesktopHandoff(f.page, options), /尚未就绪/);
  f.state.skipEnabled = true;
  assert.deepEqual(await launcher.verifyDesktopHandoff(f.page, options), {
    mainRendered: true,
    accessible: true,
    guide: "invitation",
  });
});

test("CLI Worker 有限命令转发，关闭等待清理确认及自然退出，不让Playwright接管主线程SIGINT", async () => {
  const session = cli.createCliSession({}, { workerFile: cliFixture, onStatus: () => {} });
  await session.ready;
  await session.stopDesktop();
  await session.restartDesktop();
  let closed = false;
  const closing = session.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  await closing;
  assert.equal(closed, true);
  await assert.rejects(session.restartDesktop(), /正在结束/);
});

test("CLI 初始化阶段收到取消，也等Worker完整退出才结束", async () => {
  const controller = new AbortController(),
    reason = new Error("cancelled");
  const session = cli.createCliSession(
    {},
    {
      workerFile: cliFixture,
      workerOptions: { fixture: "cancel-startup" },
      signal: controller.signal,
      onStatus: () => {},
    },
  );
  controller.abort(reason);
  await assert.rejects(session.ready, (error) => error === reason);
  await session.closed;
});

test("Worker 清理失败或确认后崩溃必须失败，不能因ACK伪报退出成功", async () => {
  for (const fixture of ["cleanup-error", "ack-crash"]) {
    let recovered = false;
    const session = cli.createCliSession(
      {},
      {
        workerFile: cliFixture,
        workerOptions: { fixture },
        onStatus: () => {},
        recover: async () => {
          recovered = true;
        },
      },
    );
    await session.ready;
    await assert.rejects(session.close(), /清理失败|意外退出/);
    assert.equal(recovered, fixture === "ack-crash");
  }
});

test("Worker 意外退出按实际上报的自有进程组收尾，保留资料且不声称焦点验证完成", async (t) => {
  const { randomUUID } = require("node:crypto");
  const directory = path.join(connectedSessionRoot(), randomUUID()),
    profileRoot = path.join(directory, "desktop");
  fs.mkdirSync(profileRoot, { recursive: true, mode: 0o700 });
  // 主线程创建真实组，再由 Worker 上报并崩溃；测试工具沙箱保留自有信号许可。
  // 生命周期交接与实际组清理都是真的，不把 kill 失败换成模拟成功。
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const session = cli.createCliSession(
    {},
    {
      workerFile: cliFixture,
      workerOptions: {
        fixture: "crash",
        directory,
        profileRoot,
        ownedPid: child.pid,
      },
      onStatus: () => {},
    },
  );
  await assert.rejects(session.ready, /意外退出/);
  await assert.rejects(session.closed, /意外退出/);
  const record = JSON.parse(fs.readFileSync(path.join(directory, "worker-exit.json")));
  assert.deepEqual(record.cleanupErrors, []);
  assert.equal(record.focusComplete, false);
  assert.equal(record.dataRetained, true);
  assert.equal(record.pids.length, 1);
  assert.throws(
    () => process.kill(-record.pids[0], 0),
    (error) => error.code === "ESRCH",
  );
  await assert.rejects(
    cli.recoverOwnedSession({
      directory: os.tmpdir(),
      profileRoot: os.tmpdir(),
    }),
    /不是本轮/,
  );
});

test("缺准备声明、JSON 损坏和文件软链接都拒绝", (t) => {
  const f = fixture(t);
  const file = path.join(f.directory, "lmcp-readiness.json");
  fs.unlinkSync(file);
  assert.throws(() => gate.checkReadiness(f.directory), /缺少 lmcp-readiness/);
  fs.writeFileSync(file, "{");
  assert.throws(() => gate.checkReadiness(f.directory), /JSON 无效/);
  fs.unlinkSync(file);
  fs.symlinkSync(path.join(f.directory, "manifest.json"), file);
  assert.throws(() => gate.checkReadiness(f.directory), /软链接/);
});

test("未知、重复、互斥参数拒绝；不接受资料根或浏览器路径", () => {
  for (const args of [
    ["--check", "--fresh"],
    ["--extension"],
    ["--help", "--extension", "/tmp/x"],
    ["--user-data-dir", "/tmp/x"],
    ["--browser", "/tmp/chrome"],
    ["--resume", "x"],
    ["--extension", "/tmp/a", "--extension", "/tmp/b"],
  ])
    assert.throws(() => gate.parseArguments(args));
  assert.equal(gate.parseArguments([]).mode, "start");
  assert.equal(gate.parseArguments(["--fresh"]).mode, "start");
});

test("--help 不读 Browser、不准备、不启动", async () => {
  const calls = [];
  const result = await launcher.main(["--help"], {
    checkReadiness: () => calls.push("read"),
    start: () => calls.push("start"),
  });
  assert.equal(result.help, true);
  assert.deepEqual(calls, []);
});

test("正常一键入口先构建，不要求先存在 Browser .output；只有 --check 只读门禁", async () => {
  let requested;
  await launcher.main(["--fresh", "--extension", "/private/tmp/not-built-candidate"], {
    checkReadiness() {
      throw new Error("不应在构建前读取候选");
    },
    start(value) {
      requested = value;
    },
  });
  assert.deepEqual(requested, {
    extensionDir: "/private/tmp/not-built-candidate",
  });
});

function child(pid = 456789) {
  const c = new EventEmitter();
  c.pid = pid;
  c.exitCode = null;
  c.signalCode = null;
  return c;
}

test("等待 descriptor 有限时、先退出立即失败，完全不读取 token", async (t) => {
  const f = fixture(t);
  let time = 0;
  await assert.rejects(
    launcher.waitDescriptor(f.directory, child(), {
      timeoutMs: 10,
      now: () => time,
      sleep: async () => {
        time += 10;
      },
    }),
    /未就绪/,
  );
  const exited = child();
  exited.exitCode = 1;
  await assert.rejects(launcher.waitDescriptor(f.directory, exited), /就绪前退出/);
  const dir = path.join(f.directory, "native-messaging");
  fs.mkdirSync(dir, { mode: 0o700 });
  const descriptor = path.join(dir, "lmcp-uds.json");
  fs.writeFileSync(descriptor, "not JSON: token must never be read", {
    mode: 0o600,
  });
  assert.equal(await launcher.waitDescriptor(f.directory, child()), descriptor);
  fs.chmodSync(descriptor, 0o644);
  await assert.rejects(launcher.waitDescriptor(f.directory, child()), /权限不安全/);
});

test("登记就绪须本轮真实origin，不能拿其他非空名单交付，也不能访问token", async () => {
  const instanceId = "b3f79858-6127-4e69-804a-4d107c921f59",
    process = child(),
    extensionId = "a".repeat(32),
    origin = `chrome-extension://${extensionId}/`;
  let time = 0;
  const ready = await launcher.waitRegisteredOrigin(
    "/unused-private-root",
    process,
    extensionId,
    instanceId,
    {
      now: () => time,
      sleep: async (ms) => (time += ms),
      readDescriptor: () => ({
        instanceId,
        pid: process.pid,
        allowedOrigins: time >= 200 ? [origin] : [`chrome-extension://${"b".repeat(32)}/`],
        get token() {
          throw new Error("不允许读取token");
        },
      }),
    },
  );
  assert.equal(time, 200);
  assert.deepEqual(ready, { instanceId, extensionOrigin: origin, ready: true });
});

test("origin投影必须来自持有的Desktop PID和同一通道实例", async () => {
  const instanceId = "b3f79858-6127-4e69-804a-4d107c921f59",
    owned = child();
  for (const [projection, error] of [
    [{ pid: owned.pid + 1, instanceId }, /不是本轮/],
    [{ pid: owned.pid, instanceId: "fe9299b6-2b88-4c62-a36b-7d18169f27c0" }, /实例.*变化/],
  ])
    await assert.rejects(
      launcher.waitRegisteredOrigin("/unused-private-root", owned, "a".repeat(32), instanceId, {
        readDescriptor: () => ({
          ...projection,
          allowedOrigins: [`chrome-extension://${"a".repeat(32)}/`],
        }),
      }),
      error,
    );
});

test("登记投影等待有界，进程退出/取消立即失败，不能因已经写注册文件而假报ready", async () => {
  const instanceId = "b3f79858-6127-4e69-804a-4d107c921f59",
    owned = child();
  let time = 0,
    reads = 0;
  const options = {
    timeoutMs: 250,
    now: () => time,
    sleep: async (ms) => (time += ms),
    readDescriptor: () => {
      reads++;
      return { instanceId, pid: owned.pid, allowedOrigins: [] };
    },
  };
  await assert.rejects(
    launcher.waitRegisteredOrigin(
      "/unused-private-root",
      owned,
      "a".repeat(32),
      instanceId,
      options,
    ),
    /尚未被 Desktop 校验/,
  );
  assert.equal(time, 250);
  const previousReads = reads;
  owned.exitCode = 1;
  await assert.rejects(
    launcher.waitRegisteredOrigin(
      "/unused-private-root",
      owned,
      "a".repeat(32),
      instanceId,
      options,
    ),
    /就绪前退出/,
  );
  assert.equal(reads, previousReads);
  const cancelled = new Error("本轮取消");
  await assert.rejects(
    launcher.waitRegisteredOrigin("/unused-private-root", child(), "a".repeat(32), instanceId, {
      ...options,
      active() {
        throw cancelled;
      },
    }),
    (error) => error === cancelled,
  );
});

test("Ctrl+C 清理只使用持有的子进程组，不按名称、不删除数据；重复停止幂等", async () => {
  const record = { processes: {} };
  const killed = [];
  let saved = 0;
  const c = child();
  const owned = new launcher.OwnedProcesses({
    record,
    save: () => {
      saved++;
    },
    sleep: async () => {},
    kill: (pid, signal) => {
      killed.push([pid, signal]);
      c.exitCode = 0;
      c.emit("exit", 0, signal);
    },
  });
  owned.add("desktop", c);
  await owned.stop("SIGINT");
  await owned.stop("SIGINT");
  assert.deepEqual(killed, [[-c.pid, "SIGTERM"]]);
  assert.equal(record.stopReason, "SIGINT");
  assert.ok(record.exitedAt);
  assert.ok(saved >= 3);
});

test("真实构建父进程已退出时仍清理其独占进程组，不遗留子工具", async (t) => {
  const script =
    "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});child.unref();console.log(child.pid);";
  const parent = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  parent.stdout.on("data", (bytes) => {
    output += bytes;
  });
  t.after(() => {
    try {
      process.kill(-parent.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  });
  const record = { processes: {} },
    owned = new launcher.OwnedProcesses({ record, save() {} });
  owned.add("owned-build", parent);
  await once(parent, "close");
  assert.equal(parent.exitCode, 0);
  assert.match(output.trim(), /^\d+$/);
  assert.equal(owned.alive(parent), false);
  assert.equal(owned.groupAlive(parent), true);
  await owned.stop("SIGINT");
  assert.equal(owned.groupAlive(parent), false);
});
