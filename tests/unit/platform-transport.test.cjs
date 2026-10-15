"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const {
  parseDescriptor,
  describeTransport,
  listenTransport,
  applyNamedPipeAcl,
  connectEndpoint,
  assertSafeEndpoint,
  bindName,
  transportKind,
  LMCP_UDS,
  MCP_UDS,
  LMCP_TRANSPORT,
  MCP_TRANSPORT,
} = require("../../electron/services/platform/transport.cjs");

test("旧 UDS 描述符视为 kind=uds，新描述符拒绝未知 kind 与非法管道名", () => {
  const socketPath = path.join(os.tmpdir(), "leximeet-legacy.sock");
  const legacy = parseDescriptor({
    format: LMCP_UDS,
    socketPath,
    token: "a".repeat(64),
    instanceId: "id",
  });
  assert.equal(legacy.kind, "uds");
  assert.equal(legacy.path, socketPath);
  const mcp = parseDescriptor({
    format: MCP_UDS,
    socketPath,
    token: "b".repeat(64),
    instanceId: "id",
  });
  assert.equal(mcp.kind, "uds");
  const pipe = "\\\\.\\pipe\\leximeet-mcp-01234567-aaaaaaaaaaaaaaaaaaaa-01234567";
  const named = parseDescriptor({
    format: MCP_TRANSPORT,
    kind: "named-pipe",
    path: pipe,
    token: "c".repeat(64),
    instanceId: "id",
  });
  assert.equal(named.kind, "named-pipe");
  assert.equal(named.path, pipe);
  assert.throws(
    () => parseDescriptor({ format: LMCP_TRANSPORT, kind: "tcp", path: "127.0.0.1:9" }),
    /SOURCE_REJECTED/,
  );
  assert.throws(
    () =>
      parseDescriptor({
        format: MCP_TRANSPORT,
        kind: "named-pipe",
        path: "\\\\.\\pipe\\other",
      }),
    /SOURCE_REJECTED/,
  );
  assert.throws(() => parseDescriptor({ format: "unknown/1", socketPath }), /SOURCE_REJECTED/);
});

test("describeTransport 在 UDS 上同时写 path 与 socketPath", () => {
  const body = describeTransport({
    purpose: "lmcp",
    kind: "uds",
    path: "/tmp/leximeet-lmcp-1/ab/cd.sock",
    token: "t".repeat(64),
    instanceId: "i",
    maxFrameBytes: 1024,
  });
  assert.equal(body.format, LMCP_TRANSPORT);
  assert.equal(body.socketPath, body.path);
  const pipe = describeTransport({
    purpose: "mcp",
    kind: "named-pipe",
    path: "\\\\.\\pipe\\leximeet-mcp-01234567-aaaaaaaaaaaaaaaaaaaa-01234567",
    token: "t".repeat(64),
    instanceId: "i",
    maxFrameBytes: 1024,
  });
  assert.equal(pipe.format, MCP_TRANSPORT);
  assert.equal(pipe.socketPath, undefined);
});

test("管道名只用短 ASCII，避免中文用户名超长", () => {
  const name = bindName({
    purpose: "lmcp",
    profileRoot: "/tmp/中文资料",
    instanceId: "01234567-89ab-4def-8123-456789abcdef",
    platform: "win32",
  });
  assert.match(name, /^\\\\[.]\\pipe\\leximeet-lmcp-[0-9a-f]+-[0-9a-f]{20}-01234567$/i);
  assert.doesNotMatch(name, /中文/);
  assert.equal(transportKind("win32"), "named-pipe");
  assert.equal(transportKind("linux"), "uds");
});

test("命名管道 ACL 收紧失败则关闭监听并启动失败", async () => {
  let closed = false;
  const server = {
    close(done) {
      closed = true;
      if (done) done();
    },
  };
  await assert.rejects(
    () =>
      applyNamedPipeAcl(server, "\\\\.\\pipe\\leximeet-test", () => {
        throw new Error("Restrict boom");
      }),
    (error) => {
      assert.equal(error.message, "NAMED_PIPE_ACL_FAILED");
      assert.equal(error.cause?.message, "Restrict boom");
      return true;
    },
  );
  assert.equal(closed, true);
});

test(
  "Windows 命名管道 listen 后 DACL 只有当前用户和 SYSTEM",
  { timeout: 20000, skip: process.platform !== "win32" },
  async (t) => {
    const {
      inspectNamedPipe,
      assertNamedPipeExclusive,
    } = require("../../electron/services/platform/win32-acl.cjs");
    const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-pipe-acl-"));
    t.after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));
    const listened = await listenTransport({
      purpose: "mcp",
      profileRoot,
      instanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    });
    t.after(() => listened.close());
    assert.equal(listened.kind, "named-pipe");
    assert.match(listened.path, /^\\\\[.]\\pipe\\leximeet-mcp-/);
    const sddl = inspectNamedPipe(listened.path);
    const checked = assertNamedPipeExclusive(sddl);
    // 回读可能是 S-1-5-21-… / S-1-5-18，也可能是 RID 500 的 LA 与 SY。
    assert.match(checked.sddl, /S-1-5-|;;;(?:LA|SY|BA)\)/);
    assert.equal(checked.hasSystem, true);
    assert.doesNotMatch(checked.sddl, /S-1-1-0|S-1-5-7|S-1-5-11|S-1-5-32-545/);
  },
);

test("本机真实 listen/connect，错误令牌路径无法握手", { timeout: 15000 }, async (t) => {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-transport-"));
  t.after(() => fs.rmSync(profileRoot, { recursive: true, force: true }));
  const listened = await listenTransport({
    purpose: "mcp",
    profileRoot,
    instanceId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    tightenPipe: () => {},
  });
  t.after(() => listened.close());
  const descriptor = describeTransport({
    purpose: "mcp",
    kind: listened.kind,
    path: listened.path,
    token: "d".repeat(64),
    instanceId: listened.instanceId,
    maxFrameBytes: 4096,
  });
  const parsed = assertSafeEndpoint(descriptor);
  assert.equal(parsed.kind, process.platform === "win32" ? "named-pipe" : "uds");
  const socket = connectEndpoint(descriptor);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.destroy();
  if (listened.kind === "named-pipe") {
    assert.throws(
      () =>
        assertSafeEndpoint({
          format: MCP_TRANSPORT,
          kind: "named-pipe",
          path: "\\\\.\\pipe\\guess",
        }),
      /UNSAFE_SOCKET|SOURCE_REJECTED/,
    );
  }
  const stray = net.connect(listened.path);
  await new Promise((resolve, reject) => {
    stray.once("connect", resolve);
    stray.once("error", reject);
  });
  stray.destroy();
});
