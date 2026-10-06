"use strict";
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const { readPrivateJson, writePrivateJson } = require("./private-files.cjs");

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(canonical(value)).digest("hex");
const sameOwner = (a, b) =>
  [
    "pairingId",
    "desktopInstanceId",
    "clientInstanceId",
    "workspaceId",
    "generation",
    "authorizationEpoch",
  ].every((key) => typeof a?.[key] === "string" && a[key] === b?.[key]);

/**
 * Desktop 消费端的有界调用日志，仅记录身份与摘要，不是 Browser 的权威回执库。
 * 不保存网页选区、URL、grant token 或返回正文；生产端 Browser 需另实现至少七天的协议回执。
 * 已发出但未确认的动作跨重启保留 unknown，恢复只能查回执，不会自动重执行。
 */
class HostOperations {
  constructor(filePath) {
    this.filePath = filePath;
    this.entries = [];
  }
  load() {
    if (!fs.existsSync(this.filePath)) return;
    const file = readPrivateJson(this.filePath, { maximumBytes: 256 * 1024 });
    if (
      file.format !== "leximeet.host-operations/1" ||
      !Array.isArray(file.entries) ||
      file.entries.length > 200
    )
      throw new Error("INVALID_HOST_OPERATIONS");
    this.entries = file.entries;
    // 应用退出前的 pending 不能被当成取消或成功。
    for (const entry of this.entries) if (entry.status === "pending") entry.status = "unknown";
    this.save();
  }
  save() {
    writePrivateJson(this.filePath, {
      format: "leximeet.host-operations/1",
      entries: this.entries,
    });
  }
  begin(grant, invocationId, method, params) {
    const inputDigest = digest({ method, params });
    const previous = this.entries.find(
      (entry) => entry.invocationId === invocationId && sameOwner(entry.owner, grant.owner),
    );
    if (previous) {
      if (previous.inputDigest !== inputDigest) throw new Error("IDEMPOTENCY_KEY_REUSED");
      if (previous.sourceGrantId !== grant.grantId) throw new Error("OPERATION_RECOVERY_REQUIRED");
      return previous;
    }
    // 只淘汰已经确认的记录，未知操作保持，容量满后明确让用户先恢复。
    while (this.entries.length >= 200) {
      const at = this.entries.findIndex((entry) =>
        ["applied", "rejected", "cancelled"].includes(entry.status),
      );
      if (at < 0) throw new Error("PENDING_OPERATIONS");
      this.entries.splice(at, 1);
    }
    const entry = {
      invocationId,
      sourceGrantId: grant.grantId,
      owner: { ...grant.owner },
      method,
      inputDigest,
      issuedAt: new Date().toISOString(),
      status: "pending",
      resultDigest: null,
    };
    this.entries.push(entry);
    this.save();
    return entry;
  }
  finish(entry, status, response) {
    if (!entry) return;
    entry.status = status;
    if (response) entry.resultDigest = digest(response);
    this.save();
  }
  // 恢复的正文可能因权限收窄而不可读，仍保存生产端确认的终态与摘要。
  recovered(entry, status, resultDigest) {
    if (!entry) return;
    entry.status = status;
    entry.resultDigest = resultDigest;
    this.save();
  }
  recover(grant, sourceGrantId, invocationId) {
    const entry = this.entries.find(
      (item) => item.sourceGrantId === sourceGrantId && item.invocationId === invocationId,
    );
    if (!entry || !sameOwner(entry.owner, grant.owner)) throw new Error("FORBIDDEN");
    return entry;
  }
  list() {
    return this.entries.map(
      ({ invocationId, sourceGrantId, owner, method, issuedAt, status, resultDigest }) => ({
        invocationId,
        sourceGrantId,
        clientInstanceId: owner.clientInstanceId,
        workspaceId: owner.workspaceId,
        generation: owner.generation,
        method,
        issuedAt,
        status,
        resultDigest,
      }),
    );
  }
}

module.exports = { HostOperations, canonical, sameOwner };
