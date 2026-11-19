"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { readPrivateJson, writePrivateJson } = require("./private-files.cjs");
const { MAX_FRAME_BYTES } = require("./framing.cjs");

const IDEA_ORIGIN = "jetbrains://com.github.weilhuang.leximeetidea";
const IDEA_METHODS = new Set([
  "hello",
  "requestConnection",
  "getConnectionStatus",
  "pair",
  "resumeSession",
  "renewSession",
  "disconnect",
  "getWorkspace",
  "getChanges",
  "matchWords",
  "getWord",
  "getPublicEntry",
]);

/** IDEA 使用单独的同用户发现文件和随机密钥，来源由 Main 固定分配。 */
class IdeaBinding {
  constructor(profileRoot) {
    this.descriptorPath = path.join(profileRoot, "idea-connector", "lmcp-uds.json");
    this.token = null;
  }

  publish(kind, socketPath, instanceId) {
    if (kind !== "uds") return;
    const token = randomBytes(32).toString("hex");
    writePrivateJson(this.descriptorPath, {
      format: "leximeet.idea-uds/1",
      instanceId,
      socketPath,
      token,
      pid: process.pid,
      maxFrameBytes: MAX_FRAME_BYTES,
    });
    this.token = token;
  }

  authenticate(message) {
    return (
      this.token !== null &&
      message?.kind === "idea-transport-auth" &&
      Object.keys(message).length === 2 &&
      typeof message.token === "string" &&
      /^[a-f0-9]{64}$/.test(message.token) &&
      timingSafeEqual(Buffer.from(message.token), Buffer.from(this.token))
    );
  }

  close(instanceId) {
    this.token = null;
    if (!instanceId) return;
    try {
      const descriptor = readPrivateJson(this.descriptorPath);
      if (descriptor.format === "leximeet.idea-uds/1" && descriptor.instanceId === instanceId)
        fs.rmSync(this.descriptorPath);
    } catch {
      // 未知或已经被别的实例接替的发现文件留在原位。
    }
  }
}

module.exports = { IDEA_ORIGIN, IDEA_METHODS, IdeaBinding };
