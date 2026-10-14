"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { createHash, randomUUID } = require("node:crypto");
const { ensurePrivateDirectory, assertPrivate } = require("./private-files.cjs");
const { currentUserKey } = require("./identity.cjs");
const { restrictNamedPipe } = require("./win32-acl.cjs");

const LMCP_UDS = "leximeet.lmcp-uds/1";
const MCP_UDS = "leximeet.mcp-uds/1";
const LMCP_TRANSPORT = "leximeet.lmcp-transport/1";
const MCP_TRANSPORT = "leximeet.mcp-transport/1";
const PIPE = /^\\\\[.]\\pipe\\leximeet-(lmcp|mcp)-[0-9a-f]+-[0-9a-f]{8,20}-[0-9a-f]{8}$/i;

function supportedPlatform(platform = process.platform) {
  return ["darwin", "linux", "win32"].includes(platform);
}

function transportKind(platform = process.platform) {
  return platform === "win32" ? "named-pipe" : "uds";
}

function bindName({ purpose, profileRoot, instanceId, platform = process.platform }) {
  if (!["lmcp", "mcp"].includes(purpose)) throw new Error("INVALID_TRANSPORT_PURPOSE");
  const user = currentUserKey(platform);
  const key = createHash("sha256").update(profileRoot).digest("hex").slice(0, 20);
  const id8 = (instanceId || randomUUID()).replace(/-/g, "").slice(0, 8);
  if (platform === "win32") return `\\\\.\\pipe\\leximeet-${purpose}-${user}-${key}-${id8}`;
  const base = `/tmp/leximeet-${purpose}-${user}`;
  return { base, key, id8 };
}

function parseDescriptor(raw) {
  if (!raw || typeof raw !== "object") throw new Error("SOURCE_REJECTED");
  if (raw.format === LMCP_UDS || raw.format === MCP_UDS) {
    if (!path.isAbsolute(raw.socketPath || "")) throw new Error("SOURCE_REJECTED");
    return { ...raw, kind: "uds", path: raw.socketPath };
  }
  if (raw.format === LMCP_TRANSPORT || raw.format === MCP_TRANSPORT) {
    if (!["uds", "named-pipe"].includes(raw.kind)) throw new Error("SOURCE_REJECTED");
    const location = raw.path || raw.socketPath;
    if (!location) throw new Error("SOURCE_REJECTED");
    if (raw.kind === "uds" && !path.isAbsolute(location)) throw new Error("SOURCE_REJECTED");
    if (raw.kind === "named-pipe" && !PIPE.test(location)) throw new Error("SOURCE_REJECTED");
    return { ...raw, path: location, socketPath: raw.kind === "uds" ? location : raw.socketPath };
  }
  throw new Error("SOURCE_REJECTED");
}

function describeTransport({
  purpose,
  kind,
  path: location,
  token,
  instanceId,
  extra = {},
  maxFrameBytes,
  pid = process.pid,
}) {
  const format = purpose === "mcp" ? MCP_TRANSPORT : LMCP_TRANSPORT;
  const body = {
    format,
    kind,
    path: location,
    token,
    instanceId,
    pid,
    maxFrameBytes,
    ...extra,
  };
  if (kind === "uds") body.socketPath = location;
  return body;
}

function assertSafeEndpoint(descriptor) {
  const parsed =
    typeof descriptor === "string"
      ? { kind: "uds", path: descriptor }
      : parseDescriptor(descriptor);
  if (parsed.kind === "named-pipe") {
    if (!PIPE.test(parsed.path)) throw new Error("UNSAFE_SOCKET");
    return parsed;
  }
  assertPrivate(path.dirname(parsed.path), { directory: true });
  const stat = fs.lstatSync(parsed.path);
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.mode & 0o077 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw new Error("UNSAFE_SOCKET");
  return parsed;
}

function connectEndpoint(descriptor) {
  const parsed = assertSafeEndpoint(descriptor);
  return net.connect(parsed.path);
}

async function listenTransport({
  purpose,
  profileRoot,
  instanceId = randomUUID(),
  platform = process.platform,
  tightenPipe = restrictNamedPipe,
  onConnection,
} = {}) {
  if (!supportedPlatform(platform)) throw new Error("LMCP_TRANSPORT_PLATFORM_UNSUPPORTED");
  const kind = transportKind(platform);
  const server = net.createServer(onConnection);
  let location;
  let socketDirectory = "";
  if (kind === "named-pipe") {
    location = bindName({ purpose, profileRoot, instanceId, platform });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen({ path: location, readableAll: false, writableAll: false }, resolve);
    });
    try {
      tightenPipe(location);
    } catch (error) {
      server.close();
      throw new Error(`NAMED_PIPE_ACL_FAILED: ${error.message}`);
    }
  } else {
    const names = bindName({ purpose, profileRoot, instanceId, platform });
    ensurePrivateDirectory(names.base);
    if (purpose === "mcp") {
      socketDirectory = path.join(names.base, names.key, names.id8);
      ensurePrivateDirectory(path.dirname(socketDirectory));
      ensurePrivateDirectory(socketDirectory);
      location = path.join(socketDirectory, "mcp.sock");
    } else {
      socketDirectory = path.join(names.base, names.key);
      ensurePrivateDirectory(socketDirectory);
      location = path.join(socketDirectory, `${names.id8}.sock`);
    }
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(location, resolve);
    });
    fs.chmodSync(location, 0o600);
  }
  return {
    kind,
    path: location,
    socketPath: kind === "uds" ? location : "",
    socketDirectory,
    server,
    instanceId,
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      if (kind === "uds" && location && fs.existsSync(location))
        fs.rmSync(location, { force: true });
      if (socketDirectory) {
        try {
          fs.rmdirSync(socketDirectory);
        } catch {
          /* 目录非空则保留 */
        }
      }
    },
  };
}

module.exports = {
  LMCP_UDS,
  MCP_UDS,
  LMCP_TRANSPORT,
  MCP_TRANSPORT,
  PIPE,
  supportedPlatform,
  transportKind,
  bindName,
  parseDescriptor,
  describeTransport,
  assertSafeEndpoint,
  connectEndpoint,
  listenTransport,
};
