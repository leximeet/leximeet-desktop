"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const {
  pidAlive,
  treeAlive,
  signalTree,
} = require("../../electron/services/platform/process-tree.cjs");

const TREE_SCRIPT =
  "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});console.log(child.pid);setInterval(()=>{},1000);";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function spawnOwnedTree(t) {
  const parent = spawn(process.execPath, ["-e", TREE_SCRIPT], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    windowsHide: true,
  });
  let output = "";
  parent.stdout.on("data", (bytes) => {
    output += bytes;
  });
  t.after(() => {
    try {
      signalTree(parent.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH" && error.code !== "EPERM") throw error;
    }
  });
  const deadline = Date.now() + 8000;
  while (!/^\d+\s*$/.test(output) && Date.now() < deadline) await delay(50);
  const childPid = Number.parseInt(output.trim(), 10);
  assert.equal(Number.isInteger(childPid) && childPid > 1, true, `未获得子进程 PID：${output}`);
  return { parent, childPid };
}

test("停止后本轮子进程确实退出", async (t) => {
  const { parent, childPid } = await spawnOwnedTree(t);
  assert.equal(pidAlive(parent.pid), true);
  assert.equal(pidAlive(childPid), true);
  signalTree(parent.pid, "SIGTERM");
  if (parent.exitCode === null && parent.signalCode === null)
    await Promise.race([once(parent, "exit"), delay(8000)]);
  if (pidAlive(parent.pid) || pidAlive(childPid) || parent.exitCode === null) {
    signalTree(parent.pid, "SIGKILL");
    if (parent.exitCode === null && parent.signalCode === null)
      await Promise.race([once(parent, "exit"), delay(4000)]);
  }
  const deadline = Date.now() + 4000;
  while ((pidAlive(parent.pid) || pidAlive(childPid)) && Date.now() < deadline) await delay(50);
  assert.equal(pidAlive(parent.pid), false);
  assert.equal(pidAlive(childPid), false);
  assert.equal(treeAlive(parent.pid), false);
});
