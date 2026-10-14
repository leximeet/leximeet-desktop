"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { encodeStdio, StdioDecoder } = require("../../electron/services/mcp/stdio-framing.cjs");

const snapshotPath = path.resolve(__dirname, "../../resources/mcp/tools-snapshot.json");

function expectedSnapshot(directory = snapshotPath) {
  return JSON.parse(fs.readFileSync(directory, "utf8"));
}

function assertTools(tools, snapshot = expectedSnapshot()) {
  if (!Array.isArray(tools) || tools.length !== snapshot.tools.length)
    throw new Error("MCP 工具数量与快照不一致");
  for (let i = 0; i < snapshot.tools.length; i++) {
    if (tools[i].name !== snapshot.tools[i].name)
      throw new Error(`MCP 工具顺序或名称偏离快照：${tools[i].name}`);
    if (Boolean(tools[i].annotations?.readOnlyHint) !== snapshot.tools[i].annotations.readOnlyHint)
      throw new Error(`MCP 工具 ${tools[i].name} 的 readOnlyHint 偏离快照`);
  }
  if (tools.some((tool) => /review|record_review/i.test(tool.name)))
    throw new Error("契约禁止出现复习提交工具");
  return snapshot;
}

// 用官方 JSON-RPC 客户端形状跑 initialize + tools/list，便于对照 MCP SDK Client。
async function listToolsWithStdio(command, args, env = process.env) {
  const child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
  const decoder = new StdioDecoder();
  const replies = [];
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("MCP 契约握手超时"));
    }, 8000);
    decoder.on("message", (message) => {
      replies.push(message);
      if (replies.length === 1)
        child.stdin.write(encodeStdio({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }));
      if (replies.length >= 2) {
        clearTimeout(timer);
        child.kill("SIGTERM");
        resolve(replies);
      }
    });
    decoder.on("error", reject);
    child.stdout.on("data", (data) => decoder.push(data));
    child.on("error", reject);
    child.stdin.write(
      encodeStdio({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "leximeet-contract", version: "1.0.1" },
        },
      }),
    );
  });
}

function verifyContract() {
  const snapshot = expectedSnapshot();
  if (snapshot.serverInfo.name !== "leximeet" || snapshot.tools.length !== 4)
    throw new Error("MCP 快照损坏");
  if (snapshot.tools[3].name !== "leximeet_write" || snapshot.tools[3].annotations.readOnlyHint)
    throw new Error("写入工具必须标 readOnlyHint=false");
  console.log("MCP 工具 schema 快照核对通过");
  return snapshot;
}

if (require.main === module) {
  try {
    verifyContract();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { verifyContract, expectedSnapshot, assertTools, listToolsWithStdio };
