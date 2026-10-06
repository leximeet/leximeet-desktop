"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseProcessRows,
  parseWindowsProcessRows,
  profileProcessTree,
} = require("../helpers/browser-process-rss.cjs");

test("RSS 只汇总本例临时 profile 的 Chromium 根进程及其后代", () => {
  const rows = parseProcessRows(`
  10 1 1000 /opt/chrome --user-data-dir=/tmp/leximeet browser-sandbox
  11 10 200 /opt/chrome --type=renderer --user-data-dir=/tmp/leximeet browser-sandbox
  12 11 300 /opt/chrome --type=utility
  20 1 5000 /opt/chrome --user-data-dir=/tmp/daily-browser
  21 20 4000 /opt/chrome --type=renderer
`);
  assert.deepEqual(profileProcessTree(rows, "/tmp/leximeet browser-sandbox"), {
    processCount: 3,
    rssBytes: 1500 * 1024,
  });
});

test("找不到或找到多个本例根进程时拒绝输出假内存数据", () => {
  const one = parseProcessRows("  10 1 1000 chrome --user-data-dir=/tmp/isolated\n");
  assert.throws(() => profileProcessTree(one, "/tmp/other"), /根进程数量异常：0/);
  assert.throws(
    () => profileProcessTree([...one, ...one.map((row) => ({ ...row, pid: 20 }))], "/tmp/isolated"),
    /根进程数量异常：2/,
  );
});

test("Windows CIM 字节工作集仅汇总带空格 profile 的 Chromium 进程树", () => {
  const rows = parseWindowsProcessRows(
    JSON.stringify([
      {
        ProcessId: 10,
        ParentProcessId: 1,
        WorkingSetSize: "1024000",
        CommandLine: 'chrome.exe --user-data-dir="C:\\Lexi Meet\\Case"',
      },
      {
        ProcessId: 11,
        ParentProcessId: 10,
        WorkingSetSize: "204800",
        CommandLine: 'chrome.exe --type=renderer --user-data-dir="C:\\Lexi Meet\\Case"',
      },
      {
        ProcessId: 20,
        ParentProcessId: 1,
        WorkingSetSize: "9999999",
        CommandLine: 'chrome.exe --user-data-dir="C:\\Lexi Meet\\Case-other"',
      },
    ]),
  );
  assert.deepEqual(profileProcessTree(rows, "c:\\lexi meet\\case", "win32"), {
    processCount: 2,
    rssBytes: 1228800,
  });
  assert.throws(
    () => parseWindowsProcessRows('[{"ProcessId":2,"ParentProcessId":1,"WorkingSetSize":"oops"}]'),
    /无效 PID 或工作集/,
  );
});
