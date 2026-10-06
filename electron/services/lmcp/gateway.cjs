"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { FrameDecoder, FrameWriter, MAX_FRAME_BYTES } = require("./framing.cjs");
const {
  ensurePrivateDirectory,
  writePrivateJson,
  readPrivateJson,
} = require("./private-files.cjs");
const { HostOperations } = require("./host-operations.cjs");
const { validateHostParams, validateHostResponse } = require("./host-validation.cjs");
const { assertRegistrationOwnership } = require("./native-registration.cjs");

const ORIGIN = /^chrome-extension:\/\/[a-p]{32}\/$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// 只接受当前冻结合同的方法；未知方法不进入 Core 私有通道。
const DESKTOP_METHODS = new Set([
  "hello",
  "pair",
  "resumeSession",
  "renewSession",
  "revokePairing",
  "disconnect",
  "getWorkspace",
  "matchWords",
  "getWord",
  "getPublicEntry",
  "recordEncounter",
  "getChanges",
  "getOperation",
  "openInDesktop",
  "listNotebooks",
  "listEncounters",
  "registerHost",
  "requestConnection",
  "getConnectionStatus",
]);
const WRITE_METHODS = new Set(["recordEncounter", "openInDesktop"]);
const HOST_CAPABILITIES = {
  "browser.getContext": "browser.context/1",
  "browser.readSelection": "browser.selection/1",
  "browser.highlight": "browser.highlight/1",
  "browser.openSource": "browser.open-source/1",
  "browser.requestSidePanel": "browser.side-panel/1",
  "browser.getOperation": null,
  "browser.cancelOperation": null,
};
function equalToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
function protocolError(request, code, message, retryable = false, resultUnknown = false) {
  return {
    apiVersion: "1.0.0",
    requestId: request.requestId,
    connectionId: request.connectionId,
    method: request.method,
    ok: false,
    error: { code, message, retryable, ...(resultUnknown ? { resultUnknown: true } : {}) },
  };
}
function transportError(code, invocationId = null, sourceGrantId = null) {
  const error = new Error(code);
  error.code = code;
  if (invocationId) {
    error.invocationId = invocationId;
    error.sourceGrantId = sourceGrantId;
    error.resultUnknown = true;
  }
  return error;
}

/**
 * Browser 只可到同用户 UDS，Core 私有 HTTP token 永不进入 Native Host。
 * 业务授权、采集幂等与工作区资料由 Core 决定；这里负责真实来源、端口代次、有界传输。
 */
class LmcpGateway {
  constructor({
    core,
    profile,
    awaitReady = async () => {},
    onDataChanged = () => {},
    onOpenInDesktop = () => {},
    onDiscovery = () => {},
    onConnectionReady = () => {},
    onCaptureCommitted = () => {},
    allowedOrigins = [],
    handshakeTimeoutMs = 5000,
    forwardTimeoutMs = 70000,
    reverseTimeoutMs = 15000,
    cleanupTimeoutMs = 5000,
    manageTimeoutMs = 15000,
    maxConnections = 16,
    maxOpenDeliveries = 256,
    navigationTimeoutMs = 5000,
    registrationPollMs = 1000,
  }) {
    if (!core?.request || !path.isAbsolute(profile?.root || ""))
      throw new Error("INVALID_GATEWAY_OPTIONS");
    Object.assign(this, {
      core,
      profile,
      awaitReady,
      onDataChanged,
      onOpenInDesktop,
      onDiscovery,
      onConnectionReady,
      onCaptureCommitted,
      handshakeTimeoutMs,
      forwardTimeoutMs,
      reverseTimeoutMs,
      cleanupTimeoutMs,
      manageTimeoutMs,
      maxConnections,
      maxOpenDeliveries,
      navigationTimeoutMs,
      registrationPollMs,
    });
    this.explicitOrigins = new Set();
    this.registrationOrigins = new Set();
    this.allowedOrigins = new Set();
    for (const origin of allowedOrigins) this.addAllowedOrigin(origin);
    this.descriptorPath = path.join(profile.root, "native-messaging", "lmcp-uds.json");
    this.operations = new HostOperations(
      path.join(profile.root, "native-messaging", "browser-invocations.json"),
    );
    this.server = null;
    this.connections = new Map();
    this.sockets = new Set();
    this.active = 0;
    // 每个已握手身份占一个生命周期槽，Core 确认真正撤销前不能被新 Port 挤走。
    this.lifecyclePorts = new Set();
    this.openDeliveries = new Map();
    this.starting = null;
    this.closing = false;
    this.lastError = null;
    this.cleanup = new Set();
  }
  addAllowedOrigin(origin) {
    if (!ORIGIN.test(origin)) throw new Error("INVALID_EXTENSION_ORIGIN");
    this.explicitOrigins.add(origin);
    this.applyAllowedOrigins();
  }
  removeAllowedOrigin(origin) {
    this.explicitOrigins.delete(origin);
    this.registrationOrigins.delete(origin);
    this.applyAllowedOrigins();
  }
  applyAllowedOrigins() {
    const next = new Set([...this.explicitOrigins, ...this.registrationOrigins]);
    const changed =
      next.size !== this.allowedOrigins.size ||
      [...next].some((origin) => !this.allowedOrigins.has(origin));
    this.allowedOrigins = next;
    if (changed) {
      this.writeDescriptor();
      for (const client of this.sockets || [])
        if (!next.has(client.origin)) client.socket.destroy();
    }
  }
  // 设置页可显式刷新；外部隔离CLI登记则由定时检查发现。只信当前profile完整注册。
  refreshRegistrations() {
    if (this.closing) throw transportError("GATEWAY_CLOSED");
    const directory = path.join(this.profile.root, "native-messaging", "registrations");
    const accepted = new Set();
    let invalid = false;
    try {
      if (fs.existsSync(directory)) {
        ensurePrivateDirectory(directory);
        const names = fs.readdirSync(directory).filter((name) => /^[a-f0-9]{32}\.json$/.test(name));
        if (names.length > 64) throw transportError("REGISTRATION_LIMIT_EXCEEDED");
        for (const name of names) {
          try {
            const file = path.join(directory, name);
            const record = readPrivateJson(file);
            if (record.profileRoot !== this.profile.root || record.recordPath !== file)
              throw transportError("REGISTRATION_NOT_OWNED");
            assertRegistrationOwnership(record);
            for (const origin of record.origins) accepted.add(origin);
          } catch {
            invalid = true;
          }
        }
      }
    } catch {
      invalid = true;
    }
    // 记录无效或被删除时，立即撤销来源并断开旧 Port，不保留上次成功刷新所得的授权。
    this.registrationOrigins = accepted;
    this.applyAllowedOrigins();
    if (invalid) {
      this.lastError = "本机Host注册校验未通过";
      throw transportError("REGISTRATION_INVALID");
    }
    if (this.lastError === "本机Host注册校验未通过") this.lastError = null;
    return { allowedOrigins: [...this.allowedOrigins], registeredOrigins: [...accepted] };
  }
  watchRegistrations() {
    this.registrationTimer = setInterval(
      () => {
        try {
          this.refreshRegistrations();
        } catch {
          // 已失效来源由刷新函数撤销；只显示固定诊断。
        }
      },
      Math.max(100, this.registrationPollMs),
    );
    this.registrationTimer.unref();
  }
  writeDescriptor() {
    if (!this.server || !this.token || this.closing) return;
    writePrivateJson(this.descriptorPath, {
      format: "leximeet.lmcp-uds/1",
      instanceId: this.instanceId,
      socketPath: this.socketPath,
      token: this.token,
      allowedOrigins: [...this.allowedOrigins],
      pid: process.pid,
      maxFrameBytes: MAX_FRAME_BYTES,
    });
  }
  async start() {
    if (this.closing) throw new Error("GATEWAY_CLOSED");
    if (this.server) return this.status();
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }
  async startInternal() {
    if (!["darwin", "linux"].includes(process.platform))
      throw new Error("LMCP_TRANSPORT_PLATFORM_UNSUPPORTED");
    this.refreshRegistrations();
    ensurePrivateDirectory(path.dirname(this.descriptorPath));
    this.operations.load();
    // 中文工作区路径会超过 macOS sockaddr_un 长度，使用短且同用户独占的临时目录。
    const base = `/tmp/leximeet-lmcp-${typeof process.getuid === "function" ? process.getuid() : "user"}`;
    ensurePrivateDirectory(base);
    const key = createHash("sha256").update(this.profile.root).digest("hex").slice(0, 20);
    this.socketDirectory = path.join(base, key);
    ensurePrivateDirectory(this.socketDirectory);
    // 每次启动独立随机目录，不覆盖仍在工作的另一份 Desktop，也不删除不明旧 socket。
    this.instanceId = randomUUID();
    this.socketPath = path.join(this.socketDirectory, `${this.instanceId.slice(0, 8)}.sock`);
    this.token = randomBytes(32).toString("hex");
    const server = net.createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, resolve);
      });
      fs.chmodSync(this.socketPath, 0o600);
      server.on("error", () => {
        this.lastError = "本机连接服务发生错误";
      });
      this.writeDescriptor();
      this.watchRegistrations();
      return this.status();
    } catch (error) {
      this.server = null;
      server.close();
      throw error;
    }
  }
  accept(socket) {
    if (this.closing || this.sockets.size >= this.maxConnections) {
      socket.destroy();
      return;
    }
    const client = {
      socket,
      origin: null,
      connectionId: null,
      grant: null,
      clientInstanceId: null,
      authorized: false,
      inflight: new Set(),
      reverse: new Map(),
      bucket: 80,
      bucketAt: Date.now(),
    };
    const decoder = new FrameDecoder();
    const writer = new FrameWriter(socket, { onError: () => socket.destroy() });
    client.writer = writer;
    this.sockets.add(client);
    const timer = setTimeout(() => socket.destroy(), this.handshakeTimeoutMs);
    timer.unref();
    client.timer = timer;
    decoder.on("error", () => socket.destroy());
    decoder.on("message", (message) => {
      if (!client.authorized) {
        if (
          message?.kind !== "transport-auth" ||
          !equalToken(message.token, this.token) ||
          !ORIGIN.test(message.extensionOrigin || "") ||
          !this.allowedOrigins.has(message.extensionOrigin)
        ) {
          socket.destroy();
          return;
        }
        clearTimeout(timer);
        client.authorized = true;
        client.origin = message.extensionOrigin;
        writer.send({ kind: "transport-ready", instanceId: this.instanceId });
        return;
      }
      if (message?.kind === "host-response") {
        this.receiveHostResponse(client, message);
        return;
      }
      void this.forward(client, message).catch(() => socket.destroy());
    });
    socket.on("data", (data) => decoder.push(data));
    socket.on("end", () => {
      decoder.finish();
      socket.destroy();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      writer.close();
      this.sockets.delete(client);
      if (client.connectionId && this.connections.get(client.connectionId) === client)
        this.connections.delete(client.connectionId);
      for (const item of client.reverse.values()) {
        clearTimeout(item.timer);
        this.finishOperation(item.entry, "unknown");
        item.reject(transportError("HOST_UNAVAILABLE", item.invocationId, item.grantId));
      }
      client.reverse.clear();
      client.grant = null;
      if (client.connectionId) {
        let cleanupTimer;
        const actualCleanup = (async () => {
          // 启动中断线也要等 Core 可用后清理；应用退出时不再为此拉起新 Core。
          if (!this.closing) await this.awaitReady();
          return this.core.request("/api/lmcp/manage", "POST", {
            action: "connectionClosed",
            connectionId: client.connectionId,
          });
        })();
        actualCleanup.then(
          () => this.lifecyclePorts.delete(client.connectionId),
          () => {},
        );
        const task = Promise.race([
          actualCleanup,
          new Promise((_, reject) => {
            cleanupTimer = setTimeout(
              () => reject(transportError("CLEANUP_TIMEOUT")),
              this.cleanupTimeoutMs,
            );
          }),
        ])
          .catch(() => {
            this.lastError = "断线授权清理未确认";
          })
          .finally(() => {
            clearTimeout(cleanupTimer);
            this.cleanup.delete(task);
          });
        this.cleanup.add(task);
      }
    });
  }
  async forward(client, envelope) {
    if (
      !envelope ||
      typeof envelope !== "object" ||
      Array.isArray(envelope) ||
      envelope.apiMajor !== 1 ||
      !UUID.test(envelope.requestId || "") ||
      !UUID.test(envelope.connectionId || "") ||
      typeof envelope.method !== "string" ||
      !/^[a-z][A-Za-z]{0,79}$/.test(envelope.method) ||
      !envelope.params ||
      typeof envelope.params !== "object" ||
      Array.isArray(envelope.params) ||
      Object.keys(envelope).some(
        (k) =>
          !["apiMajor", "requestId", "connectionId", "method", "params", "authorization"].includes(
            k,
          ),
      )
    ) {
      client.socket.destroy();
      return;
    }
    if (!client.connectionId) {
      if (
        envelope.method !== "hello" ||
        this.lifecyclePorts.has(envelope.connectionId) ||
        this.lifecyclePorts.size >= this.maxConnections
      ) {
        client.socket.destroy();
        return;
      }
      client.connectionId = envelope.connectionId;
      this.lifecyclePorts.add(client.connectionId);
      this.connections.set(client.connectionId, client);
    }
    if (envelope.connectionId !== client.connectionId) {
      client.socket.destroy();
      return;
    }
    if (!DESKTOP_METHODS.has(envelope.method)) {
      client.writer.send(protocolError(envelope, "CAPABILITY_UNAVAILABLE", "桌面未提供这个接口"));
      return;
    }
    const now = Date.now();
    client.bucket = Math.min(80, client.bucket + (now - client.bucketAt) / 25);
    client.bucketAt = now;
    if (client.bucket < 1 || client.inflight.size >= 8 || this.active >= 32) {
      client.writer.send(protocolError(envelope, "RATE_LIMITED", "本机连接繁忙，请稍后重试", true));
      return;
    }
    if (client.inflight.has(envelope.requestId)) {
      client.socket.destroy();
      return;
    }
    client.bucket--;
    client.inflight.add(envelope.requestId);
    this.active++;
    // 授权变更若已被Core提交但ACK丢失，也不能继续使用旧grant；等待新的成功登记。
    this.invalidateTransitionGrants(client, envelope);
    let timeout;
    try {
      const task = (async () => {
        await this.awaitReady();
        return this.core.request("/api/lmcp/rpc", "POST", {
          envelope,
          extensionOrigin: client.origin,
          connectionId: client.connectionId,
        });
      })();
      // 给浏览器超时回复，不表示 Core 已结束；直到真实任务结束才释放全局额度。
      task.then(
        (result) => {
          this.active--;
          // 已提交后断线/丢 ACK 仍需要通知本机视图重新读取，不能只在成功送达后刷新。
          if (
            result?.ok &&
            envelope.method === "recordEncounter" &&
            result.result?.captureStatus !== "duplicate-context"
          ) {
            Promise.resolve()
              .then(() => this.onDataChanged())
              .catch(() => {
                this.lastError = "本机视图刷新未确认";
              });
            // 从真实 Core 完成处消费，浏览器断线或送达超时不会漏掉已成功的采集。
            // 统一接口适用于各插件；只传通知所需的少量资料，不传认证或完整语境。
            Promise.resolve()
              .then(() =>
                this.onCaptureCommitted({
                  workspaceId: envelope.authorization?.workspaceId,
                  generation: envelope.authorization?.generation,
                  eventId: result.result?.entity?.entityId,
                  word: result.result?.entity?.data?.surface,
                  pluginName: client.displayName,
                }),
              )
              .catch(() => {
                this.lastError = "采集通知未确认，采集资料仍已保存";
              });
          }
        },
        () => this.active--,
      );
      const result = await Promise.race([
        task,
        new Promise((_, reject) => {
          timeout = setTimeout(
            () => reject(transportError("DEADLINE_EXCEEDED")),
            this.forwardTimeoutMs,
          );
          timeout.unref();
        }),
      ]);
      if (client.socket.destroyed || client.connectionId !== envelope.connectionId) return;
      if (
        !result ||
        result.requestId !== envelope.requestId ||
        result.connectionId !== envelope.connectionId ||
        result.method !== envelope.method ||
        typeof result.ok !== "boolean"
      )
        throw transportError("INVALID_CORE_RESPONSE");
      if (result.ok) {
        if (envelope.method === "hello") {
          client.clientInstanceId = envelope.params.clientInstanceId;
          client.displayName = envelope.params.displayName;
          Promise.resolve()
            .then(() => this.onDiscovery(client))
            .catch(() => {
              this.lastError = "插件发现提醒未确认";
            });
        }
        if (["pair", "resumeSession"].includes(envelope.method)) {
          client.clientInstanceId =
            envelope.params.clientInstanceId ||
            result.result?.owner?.clientInstanceId ||
            client.clientInstanceId;
          client.owner = result.result?.owner || null;
          client.businessReady = false;
          client.grant = null;
          if (envelope.method === "pair")
            for (const other of this.connections.values()) {
              if (
                other.origin === client.origin &&
                other.clientInstanceId === client.clientInstanceId
              )
                other.grant = null;
            }
        }
        if (envelope.method === "getWorkspace" && client.owner) {
          client.businessReady = true;
          client.readyRuntimeGeneration = this.core.generation;
          this.onConnectionReady(client);
        }
        if (envelope.method === "registerHost") {
          const grant = result.result;
          if (
            !UUID.test(grant?.grantId || "") ||
            typeof grant.grantToken !== "string" ||
            grant.grantToken.length < 32 ||
            grant.grantToken.length > 128 ||
            !grant.owner ||
            !UUID.test(grant.owner.pairingId || "") ||
            !UUID.test(grant.owner.desktopInstanceId || "") ||
            grant.owner.clientInstanceId !== client.clientInstanceId ||
            (client.owner &&
              Object.keys(client.owner).some((key) => grant.owner[key] !== client.owner[key])) ||
            grant.owner.workspaceId !== envelope.authorization?.workspaceId ||
            grant.owner.generation !== envelope.authorization?.generation ||
            grant.owner.authorizationEpoch !== envelope.authorization?.authorizationEpoch ||
            grant.extensionId !== "browser/1" ||
            envelope.params.extensionId !== "browser/1" ||
            !Array.isArray(grant.capabilities) ||
            grant.capabilities.length < 1 ||
            grant.capabilities.length > 5 ||
            new Set(grant.capabilities).size !== grant.capabilities.length ||
            grant.capabilities.some(
              (capability) =>
                !Object.values(HOST_CAPABILITIES).includes(capability) ||
                !envelope.params.capabilities.includes(capability),
            ) ||
            !Number.isFinite(Date.parse(grant.expiresAt)) ||
            Date.parse(grant.expiresAt) <= Date.now() ||
            Date.parse(grant.expiresAt) > Date.now() + 600000
          )
            throw transportError("INVALID_CORE_RESPONSE");
          // Core 对同 pairing 登记新 grant 时撤销旧 grant；Main 必须同步使其他 Port 的缓存失效。
          for (const other of this.connections.values())
            if (other.grant?.owner?.pairingId === grant.owner.pairingId) other.grant = null;
          client.grant = grant;
          client.grantRuntimeGeneration = this.core.generation;
          client.clientInstanceId = grant.owner.clientInstanceId;
        }
        if (["disconnect", "revokePairing"].includes(envelope.method)) client.grant = null;
        if (envelope.method === "openInDesktop") {
          // Core 回执先确认；页面导航失败独立显示，不能把已成功的业务改报失败。
          const completion = this.deliverOpenInDesktop(client, envelope, result.result);
          // 路由配送令牌只属于 Main/Core 私有通道，不能进入 Browser。
          const { navigationDelivery, navigationPending, ...publicResult } = result.result;
          if (completion) {
            let navigationTimer;
            try {
              const confirmed = await Promise.race([
                completion,
                new Promise((resolve) => {
                  navigationTimer = setTimeout(() => resolve(null), this.navigationTimeoutMs);
                  navigationTimer.unref();
                }),
              ]);
              if (confirmed) publicResult.opened = confirmed.opened;
            } finally {
              clearTimeout(navigationTimer);
            }
          }
          result.result = publicResult;
        }
      } else if (
        [
          "UNAUTHORIZED",
          "FORBIDDEN",
          "PAIRING_REVOKED",
          "SESSION_EXPIRED",
          "AUTHORIZATION_REVOKED",
          "WORKSPACE_MISMATCH",
          "GENERATION_MISMATCH",
          "STALE_CONNECTION",
        ].includes(result.error?.code)
      )
        client.grant = null;
      try {
        client.writer.send(result);
      } catch (error) {
        if (error.message !== "PAYLOAD_TOO_LARGE") throw error;
        // Core 已确认提交，回执编码失败不能变成“事务未执行”的业务拒绝。
        client.writer.send(
          protocolError(
            envelope,
            "PAYLOAD_TOO_LARGE",
            "响应超过单帧上限，请缩小查询范围",
            false,
            result.ok && WRITE_METHODS.has(envelope.method),
          ),
        );
      }
    } catch (error) {
      if (!client.socket.destroyed)
        client.writer.send(
          protocolError(
            envelope,
            error.code === "DEADLINE_EXCEEDED" ? "DEADLINE_EXCEEDED" : "HOST_UNAVAILABLE",
            error.code === "DEADLINE_EXCEEDED"
              ? "请求结果尚未确认，请查询原操作回执"
              : "桌面服务暂不可用",
            true,
            WRITE_METHODS.has(envelope.method),
          ),
        );
    } finally {
      clearTimeout(timeout);
      client.inflight.delete(envelope.requestId);
    }
  }
  invalidateTransitionGrants(client, envelope) {
    if (
      !["pair", "resumeSession", "registerHost", "disconnect", "revokePairing"].includes(
        envelope.method,
      )
    )
      return;
    const pairingId = client.grant?.owner?.pairingId;
    const instanceId = ["pair", "resumeSession"].includes(envelope.method)
      ? envelope.params.clientInstanceId
      : client.clientInstanceId;
    for (const other of this.connections.values()) {
      if (
        other === client ||
        (pairingId && other.grant?.owner?.pairingId === pairingId) ||
        (instanceId && other.origin === client.origin && other.clientInstanceId === instanceId)
      )
        other.grant = null;
    }
  }
  // JavaRuntime每次启动/停止递增代次；Core短授权失效时Main不继续使用缓存grant。
  expireRuntimeGrant(client) {
    if (client.grant && client.grantRuntimeGeneration !== this.core.generation) client.grant = null;
  }
  receiveHostResponse(client, message) {
    this.expireRuntimeGrant(client);
    const item = client.reverse.get(message.requestId);
    // 旧 grant/旧端口响应不能影响新连接；无对应请求的迟到 ACK 只丢弃。
    if (!item) return;
    if (
      message.apiMajor !== 1 ||
      message.connectionId !== client.connectionId ||
      message.invocationId !== item.invocationId ||
      message.method !== item.method ||
      typeof message.ok !== "boolean" ||
      (message.ok ? !Object.hasOwn(message, "result") : !message.error) ||
      !validateHostResponse(message, item.params)
    ) {
      client.socket.destroy();
      return;
    }
    let recovered;
    if (message.ok && item.method === "browser.getOperation") {
      const receipt = message.result.receipt;
      if (
        message.result.contentStatus === "available" &&
        !client.grant?.capabilities.includes(HOST_CAPABILITIES[receipt.method])
      ) {
        client.socket.destroy();
        return;
      }
      try {
        recovered = this.operations.recover(
          client.grant,
          item.params.sourceGrantId,
          item.params.invocationId,
        );
      } catch {
        // 控制面也可查询本地窗口已淘汰的记录；Browser 仍校验原归属。
      }
      if (recovered && receipt && recovered.method !== receipt.method) {
        client.socket.destroy();
        return;
      }
    }
    client.reverse.delete(message.requestId);
    clearTimeout(item.timer);
    if (
      client.grant?.grantId !== item.grantId ||
      Date.parse(client.grant.expiresAt) <= Date.now()
    ) {
      this.finishOperation(item.entry, "unknown");
      item.reject(transportError("STALE_GRANT", item.invocationId, item.grantId));
      return;
    }
    this.finishOperation(
      item.entry,
      message.ok ? "applied" : "rejected",
      message.ok
        ? { method: message.method, ok: true, result: message.result }
        : { method: message.method, ok: false, error: message.error },
    );
    if (
      message.ok &&
      item.method === "browser.getOperation" &&
      ["applied", "rejected", "cancelled"].includes(message.result?.status)
    ) {
      try {
        this.operations.recovered(recovered, message.result.status, message.result.resultDigest);
      } catch {
        this.lastError = "浏览器调用状态保存未确认";
      }
    }
    item.resolve(message);
  }
  finishOperation(entry, status, response) {
    try {
      this.operations.finish(entry, status, response);
    } catch {
      this.lastError = "浏览器调用状态保存未确认";
    }
  }
  /**
   * 只有 Core 首次签发的私有配送令牌才能触发页面动作。
   * 重放/重启后未知的导航没有令牌，保持 pending，不能因 opened=false 再打开窗口。
   */
  deliverOpenInDesktop(client, envelope, result) {
    const delivery = result?.navigationDelivery;
    if (!delivery) return;
    if (
      !UUID.test(delivery.pairingId || "") ||
      !UUID.test(delivery.mutationId || "") ||
      typeof delivery.deliveryToken !== "string" ||
      delivery.deliveryToken.length < 32 ||
      delivery.connectionId !== client.connectionId ||
      delivery.mutationId !== envelope.params.mutationId
    ) {
      this.lastError = "桌面页面打开身份未确认";
      return;
    }
    const key = createHash("sha256")
      .update(JSON.stringify([delivery.pairingId, delivery.mutationId, delivery.deliveryToken]))
      .digest("hex");
    if (this.openDeliveries.has(key)) return this.openDeliveries.get(key).promise;
    if (this.openDeliveries.size >= this.maxOpenDeliveries) {
      // 已确认配送才可淘汰；永不因等待超时释放仍在执行的回调槽。
      const previous = [...this.openDeliveries].find(([, value]) => value.settled);
      if (!previous) {
        this.lastError = "桌面导航队列繁忙";
        return;
      }
      this.openDeliveries.delete(previous[0]);
    }
    const entry = { settled: false };
    this.openDeliveries.set(key, entry);
    entry.promise = Promise.resolve()
      .then(async () => {
        const confirmation = await this.onOpenInDesktop(envelope.params, result);
        const opened = confirmation === true || confirmation?.opened === true;
        // Main 必须实际收到 UI 路由确认；传输成功和真正导航完成不能揉成一个结果。
        const completed = await this.manage({
          action: "completeNavigation",
          pairingId: delivery.pairingId,
          mutationId: delivery.mutationId,
          connectionId: delivery.connectionId,
          deliveryToken: delivery.deliveryToken,
          opened,
        });
        if (completed?.opened !== opened) throw transportError("INVALID_CORE_RESPONSE");
        if (!opened) this.lastError = "桌面页面打开未确认";
        return { opened };
      })
      .catch(() => {
        this.lastError = "桌面页面打开未确认";
        return null;
      })
      .finally(() => {
        entry.settled = true;
      });
    return entry.promise;
  }
  async recoverBrowserOperation(connectionId, { sourceGrantId, invocationId }) {
    const client = this.connections.get(connectionId);
    if (client) this.expireRuntimeGrant(client);
    const grant = client?.grant;
    if (!grant) throw transportError("HOST_UNAVAILABLE");
    this.operations.recover(grant, sourceGrantId, invocationId);
    return this.invokeBrowser(connectionId, "browser.getOperation", {
      sourceGrantId,
      invocationId,
    });
  }
  async invokeBrowser(
    connectionId,
    method,
    params,
    { invocationId = randomUUID(), timeoutMs = this.reverseTimeoutMs } = {},
  ) {
    const client = this.connections.get(connectionId);
    if (client) this.expireRuntimeGrant(client);
    const grant = client?.grant;
    if (!client || client.socket.destroyed || !grant) throw transportError("HOST_UNAVAILABLE");
    if (
      !Object.hasOwn(HOST_CAPABILITIES, method) ||
      (HOST_CAPABILITIES[method] && !grant.capabilities.includes(HOST_CAPABILITIES[method]))
    )
      throw transportError("CAPABILITY_UNAVAILABLE");
    if (Date.parse(grant.expiresAt) <= Date.now()) {
      client.grant = null;
      throw transportError("STALE_GRANT");
    }
    if (!UUID.test(invocationId) || !validateHostParams(method, params) || client.reverse.size >= 8)
      throw transportError("INVALID_ARGUMENT");
    const duration = Math.max(1, Math.min(30000, timeoutMs));
    const requestId = randomUUID();
    const { owner } = grant;
    const request = {
      apiMajor: 1,
      kind: "host-request",
      connectionId,
      requestId,
      invocationId,
      method,
      grantId: grant.grantId,
      grantToken: grant.grantToken,
      workspace: { workspaceId: owner.workspaceId, generation: owner.generation },
      deadlineAt: new Date(Date.now() + duration).toISOString(),
      params,
    };
    // 控制面的查询/取消不构成新的网页动作，不需要另存一条动作回执。
    let entry;
    if (!["browser.getOperation", "browser.cancelOperation"].includes(method)) {
      try {
        entry = this.operations.begin(grant, invocationId, method, params);
      } catch (error) {
        throw transportError(error.message);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        client.reverse.delete(requestId);
        this.finishOperation(entry, "unknown");
        reject(transportError("DEADLINE_EXCEEDED", invocationId, grant.grantId));
      }, duration);
      timer.unref();
      client.reverse.set(requestId, {
        resolve,
        reject,
        timer,
        invocationId,
        grantId: grant.grantId,
        method,
        params,
        entry,
      });
      try {
        client.writer.send(request);
      } catch (error) {
        clearTimeout(timer);
        client.reverse.delete(requestId);
        this.finishOperation(entry, "unknown");
        // write 失败也可能已有部分字节进入管道；不要把副作用宣称为未执行。
        const failure = transportError(error.message, invocationId, grant.grantId);
        reject(failure);
      }
    });
  }
  async manage(input = { action: "state" }) {
    if (this.closing) throw transportError("GATEWAY_CLOSED");
    if (this.active >= 32) throw transportError("RATE_LIMITED");
    if (["revoke", "disconnect"].includes(input.action))
      for (const client of this.sockets) {
        if (!input.clientInstanceId || client.clientInstanceId === input.clientInstanceId)
          client.grant = null;
      }
    this.active++;
    const task = (async () => {
      await this.awaitReady();
      return this.core.request("/api/lmcp/manage", "POST", input);
    })();
    task.then(
      () => {
        this.active--;
        // 设置页已超时不等于撤权失败；Core 最终确认后仍关闭旧链路。
        if (["revoke", "disconnect"].includes(input.action))
          for (const client of this.sockets) {
            if (!input.clientInstanceId || client.clientInstanceId === input.clientInstanceId)
              client.socket.destroy();
          }
      },
      () => this.active--,
    );
    let timer;
    try {
      return await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(transportError("DEADLINE_EXCEEDED")),
            this.manageTimeoutMs,
          );
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  status() {
    for (const client of this.connections.values()) this.expireRuntimeGrant(client);
    return {
      running: !!this.server && !this.closing,
      transport: "unix-domain-socket",
      descriptorPath: this.descriptorPath,
      lastError: this.lastError,
      activeRequests: this.active,
      cleanupPendingCount: Math.max(0, this.lifecyclePorts.size - this.connections.size),
      browserOperations: this.operations.list(),
      connections: [...this.connections.values()].map((client) => ({
        connectionId: client.connectionId,
        extensionOrigin: client.origin,
        clientInstanceId: client.clientInstanceId,
        pairingId: client.owner?.pairingId || null,
        businessReady:
          client.businessReady === true && client.readyRuntimeGeneration === this.core.generation,
        hostCapabilities: client.grant?.capabilities || [],
        hostExpiresAt: client.grant?.expiresAt || null,
      })),
    };
  }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    clearInterval(this.registrationTimer);
    this.closePromise = this.closeInternal();
    return this.closePromise;
  }
  async closeInternal() {
    if (this.starting) await this.starting.catch(() => {});
    // net.Server.close 的回调可能早于 Socket close 事件；先登记并等每条生命周期清理。
    const closedSockets = [...this.sockets].map(
      (client) => new Promise((resolve) => client.socket.once("close", resolve)),
    );
    for (const client of this.sockets) client.socket.destroy();
    const server = this.server;
    this.server = null;
    if (server) await new Promise((resolve) => server.close(resolve));
    await Promise.allSettled(closedSockets);
    await Promise.allSettled([...this.cleanup]);
    if (fs.existsSync(this.descriptorPath)) {
      const descriptor = readPrivateJson(this.descriptorPath);
      if (descriptor.instanceId === this.instanceId) fs.rmSync(this.descriptorPath);
    }
    if (this.socketPath && fs.existsSync(this.socketPath)) fs.rmSync(this.socketPath);
    if (this.socketDirectory) {
      // 只删除自己使用过的空目录；同资料根另一实例的 socket 和不明旧文件均保留。
      try {
        fs.rmdirSync(this.socketDirectory);
      } catch {
        // 非空或已不存在都无需继续清理。
      }
    }
    this.connections.clear();
    this.token = null;
  }
}

module.exports = { LmcpGateway, protocolError, ORIGIN, UUID, DESKTOP_METHODS, HOST_CAPABILITIES };
