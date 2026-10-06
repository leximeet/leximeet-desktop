"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("@playwright/test");
const gate = require("../../scripts/lib/connected-readiness.cjs");
const { startPackagedLab } = require("../../scripts/accept-connected.cjs");
const { spawn } = require("node:child_process");

// 独立证明真实随包 JRE 与外置 Host，使用当前一键邀请与采集交互。
test("随包 app + 原生侧栏：宿主 Java 不可用仍可配对、采集、重启与断开", async ({}, info) => {
  const packageDirectory = process.env.LEXIMEET_CONNECTED_PACKAGE_ROOT;
  if (!packageDirectory || !path.isAbsolute(packageDirectory) || !fs.existsSync(packageDirectory))
    throw new Error(
      "请先构建当前验收 app，并设置 LEXIMEET_CONNECTED_PACKAGE_ROOT；包级测试不会降级源码",
    );
  const session = await startPackagedLab(gate.checkReadiness(), {
    headless: true,
    prepare: false,
    poisonHostJava: true,
    packageDirectory,
    outputDir: info.outputPath("evidence"),
    onStatus: () => {},
  });
  let failure;
  const connection = () =>
    session.workspace.evaluate(async () => {
      const response = await chrome.runtime.sendMessage({
        channel: "leximeet",
        action: "connection-state",
        data: {},
      });
      if (!response.ok) throw new Error(response.error);
      return response.result;
    });
  const query = (payload) =>
    session.desktopPage.evaluate((data) => window.leximeet.desktopQuery(data), payload);
  try {
    expect(session.record.application).toMatchObject({
      packaged: true,
      hostJavaPoisoned: true,
    });
    expect(session.record.application.bundledJava).toMatch(
      /LexiMeet(?: Acceptance)?\.app\/Contents\/Resources\/runtime\/bin\/java$/,
    );
    expect(session.record.packagedArtifacts.dictionaryIndex).toMatchObject({
      indexVersion: 3,
      version: "0.0.3",
      edition: "core-text",
    });
    expect(session.record.registration).toMatchObject({
      isolated: true,
      hostName: "org.leximeet.browser",
    });
    const desktop = session.desktopPage;
    const welcome = desktop.getByRole("dialog", { name: "欢迎使用词遇" });
    if (await welcome.count())
      await welcome.getByRole("button", { name: "跳过教学", exact: true }).click();
    await desktop.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "collect",
        word: "system",
        note: "随包桌面 B",
      }),
    );
    const ui = require("./packaged-helpers.cjs");
    ui.adaptSession(session);
    await ui.pairThroughUi(session);
    const panel = await session.openPanel();
    await expect(panel.getByRole("contentinfo", { name: "运行状态" })).toContainText(
      "已连接桌面端",
    );
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(panel.getByRole("region", { name: "遇见单词列表" })).toContainText(/system/i);
    await panel
      .locator(".lm-row")
      .filter({ hasText: /^system/i })
      .first()
      .click();
    await expect(panel.getByRole("article", { name: "桌面词卡", exact: true })).toContainText(
      "随包桌面 B",
    );
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.getByRole("button", { name: "结束采集", exact: true })).toBeVisible();
    await expect(panel.locator(".lm-row")).toHaveCount(0);
    // 只操作本轮阅读页 DOM；不读取或写入系统剪贴板、系统键鼠。
    await session.reading.locator("strong").filter({ hasText: "resilient" }).click();
    await expect(panel.locator(".lm-detail h2")).toHaveText("resilient");
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(async () => (await query({ kind: "encounters" })).total).toBe(1);
    const saved = (await query({ kind: "encounters" })).encounters[0];
    expect(saved).toMatchObject({
      word: "resilient",
      sourceUrl: session.reading.url(),
    });
    expect(saved.context).toContain("resilient");
    await session.stopDesktop();
    await expect.poll(connection).toMatchObject({ mode: "desktop", status: "reconnecting" });
    await session.restartDesktop();
    // 仍使用原生侧栏原实例；之前采集后停留在采集页，用户先切回遇见再分析。
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect.poll(connection).toMatchObject({ mode: "desktop", status: "connected" });
    expect((await query({ kind: "encounters" })).total).toBe(1);
    await ui.disconnectThroughUi(session.workspace);
    await expect.poll(connection).toMatchObject({ mode: "independent", status: "independent" });
    expect((await query({ kind: "encounters" })).total).toBe(1);
    session.record.scenarios = {
      actualPackagedApplication: true,
      unusableHostJava: true,
      packagedNativeHost: true,
      actualSidePanel: true,
      captureInDesktopOnly: true,
      sameProfileRestart: true,
      explicitDetach: true,
    };
  } catch (error) {
    failure = error;
    for (const [label, page] of [
      ["desktop", session.desktopPage],
      ["browser", session.workspace],
    ])
      if (page && !page.isClosed())
        try {
          await info.attach(label, {
            body: await page.screenshot(),
            contentType: "image/png",
          });
        } catch {
          // 保留原始失败。
        }
  } finally {
    try {
      await session.close();
    } catch (error) {
      failure ||= error;
    }
  }
  try {
    if (failure) throw failure;
    expect(session.record.focus.complete).toBe(true);
    expect(session.record.focus.violations).toEqual([]);
    expect(session.record.background.violations).toEqual([]);
    expect(session.record.cleanupErrors).toEqual([]);
    expect(session.record.productionBytesUnchanged).toBe(true);
    session.record.jointAcceptancePassed = true;
  } finally {
    session.saveEvidence();
  }
});

test("随包隔离 CLI 收到真实 SIGINT 后完成两个隐藏进程、注册与焦点清理", async ({}, info) => {
  const output = info.outputPath("cli-evidence");
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(output, "cli.log"), "w", 0o600);
  const child = spawn(process.execPath, [path.join(__dirname, "fixtures/packaged-cli.cjs")], {
    cwd: path.resolve(__dirname, "../.."),
    detached: true,
    env: { ...process.env, LEXIMEET_CLI_EVIDENCE: output },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let metadata, result;
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (bytes) => fs.writeSync(fd, bytes));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise((resolve, reject) => {
    child.on("message", (message) => {
      if (message.type === "ready") {
        metadata = message.value;
        resolve();
      }
      if (message.type === "closed") result = message.value;
    });
    child.once("exit", (code) => reject(new Error(`随包 CLI 就绪前退出 ${code}，见 cli.log`)));
  });
  try {
    await ready;
    expect(fs.existsSync(metadata.directory)).toBe(true);
    expect(child.kill("SIGINT")).toBe(true);
    expect(await exited).toEqual({ code: 130, signal: null });
    expect(result.headless).toBe(true);
    expect(result.application.packaged).toBe(true);
    expect(result.application.hostJavaPoisoned).toBe(true);
    // 正式词典索引使用 v3；同一用例继续核验真实退出、注册撤销与焦点清理。
    expect(result.packagedArtifacts.dictionaryIndex.indexVersion).toBe(3);
    expect(result.focus.complete).toBe(true);
    expect(result.focus.violations).toEqual([]);
    expect(result.cleanupErrors).toEqual([]);
    expect(result.productionBytesUnchanged).toBe(true);
    expect(fs.existsSync(result.registration.manifestPath)).toBe(false);
    for (const pid of [
      ...Object.values(result.processes).map((item) => item.pid),
      result.browser.pid,
    ]) {
      let status = "present";
      try {
        process.kill(pid, 0);
      } catch (error) {
        status = error.code;
      }
      expect(status).toBe("ESRCH");
    }
    expect(fs.existsSync(metadata.directory)).toBe(true);
    expect(result.artifactsReclaimed).toBe(true);
    for (const folder of ["application", "desktop", "browser-extension"])
      expect(fs.existsSync(path.join(metadata.directory, folder))).toBe(false);
    await info.attach("cli-boundary", {
      body: Buffer.from(
        JSON.stringify({
          sigint: true,
          exitCode: 130,
          packaged: true,
          focus: result.focus,
          cleanupErrors: result.cleanupErrors,
          ownRegistrationRemoved: true,
          ownPidsExited: true,
          dataRetained: false,
          artifactsReclaimed: true,
          recordRetained: true,
        }),
      ),
      contentType: "application/json",
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
    fs.closeSync(fd);
  }
});
