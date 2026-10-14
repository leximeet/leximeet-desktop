"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { probeMavenJava } = require("../../scripts/java.cjs");

test("Windows 探测 Maven JDK 超时更宽，冷启动失败会重试", () => {
  let calls = 0;
  const information = probeMavenJava({
    platform: "win32",
    spawn(command, args, options) {
      calls += 1;
      assert.equal(command, "mvn.cmd -version");
      assert.equal(options.timeout, 30000);
      if (calls < 3) return { status: 1, stdout: "", stderr: "Java hot-spot starting" };
      return { status: 0, stdout: "Apache Maven 3.9.9\nJava version: 21.0.8", stderr: "" };
    },
  });
  assert.equal(calls, 3);
  assert.match(information, /Java version: 21/);
});

test("探测失败时带上 Maven 实际输出，避免只剩笼统提示", () => {
  assert.throws(
    () =>
      probeMavenJava({
        platform: "linux",
        spawn() {
          return { status: 1, stdout: "", stderr: "Java version: 17.0.12" };
        },
      }),
    /Java version: 17/,
  );
});
