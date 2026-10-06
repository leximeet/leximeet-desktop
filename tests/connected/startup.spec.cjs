"use strict";
const { createServer } = require("node:http");
const { test, expect } = require("@playwright/test");
const gate = require("../../scripts/lib/connected-readiness.cjs");
const { startPackagedLab } = require("../../scripts/accept-connected.cjs");

// 人工默认教学置前也走真实随包入口；显示方式保持后台，不激活用户正在工作的应用。
for (const fallback of [false, true]) {
  test(`随包人工启动页：真实教学置前，${fallback ? "文档超时仍保留本地阅读页" : "另留离线英文阅读页"}`, async ({}, info) => {
    let slow, session, failure;
    const statuses = [];
    try {
      let readingUrl = "local";
      if (fallback) {
        // 真实慢 HTTP 服务，不替换 goto 结果、Chrome API 或生产包。
        slow = createServer(() => {});
        await new Promise((resolve, reject) => {
          slow.once("error", reject);
          slow.listen(0, "127.0.0.1", resolve);
        });
        readingUrl = `http://127.0.0.1:${slow.address().port}/slow`;
      }
      const packageDirectory = process.env.LEXIMEET_CONNECTED_PACKAGE_ROOT;
      session = await startPackagedLab(gate.checkReadiness(), {
        // 可复用明确指定的当前随包 app；未指定时实际构建本轮 app，不降级源码。
        headless: true,
        prepare: !packageDirectory,
        poisonHostJava: true,
        packageDirectory,
        startupPage: "tutorial",
        readingUrl,
        navigationTimeout: fallback ? 1000 : 20000,
        outputDir: info.outputPath("evidence"),
        onStatus: (message) => statuses.push(message),
      });
      const guideUrl = `chrome-extension://${session.extensionId}/tutorial.html`;
      const tutorial = session.context.pages().find((page) => page.url() === guideUrl);
      expect(tutorial).toBeTruthy();
      await expect(
        tutorial.getByRole("heading", { name: "A small habit, a lasting change." }),
      ).toBeVisible();
      const actual = await session.workspace.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const contexts = await chrome.runtime.getContexts({});
        const connection = await chrome.runtime.sendMessage({
          channel: "leximeet",
          action: "connection-state",
          data: {},
        });
        if (!connection.ok) throw new Error(connection.error);
        return { tabs, contexts, connection: connection.result };
      });
      const guide = actual.contexts.find((item) => item.documentUrl === guideUrl);
      expect(actual.tabs).toHaveLength(3);
      expect(actual.tabs.find((item) => item.active).id).toBe(guide.tabId);
      expect(actual.contexts.filter((item) => item.contextType === "SIDE_PANEL")).toHaveLength(0);
      expect(actual.connection.mode).toBe("independent");
      expect(session.record.startupUrl).toBe(guideUrl);
      expect(session.record.readingFallback).toBe(fallback);
      expect(session.reading.url()).toBe(session.record.localUrl);
      expect(session.record.requestedReadingUrl).toBe(
        fallback ? readingUrl : session.record.localUrl,
      );
      await expect(
        session.reading.getByRole("heading", { name: "Building a reliable system", exact: true }),
      ).toBeVisible();
      expect(session.record.application.packaged).toBe(true);
      expect(session.record.application.hostJavaPoisoned).toBe(true);
      expect(session.record.desktopRendered).toMatchObject({
        mainRendered: true,
        accessible: true,
      });
      // 导航或降级完成之后仍要核验当前真实 Desktop，不能沿用导航前的快照。
      expect(session.record.desktopHandoffRendered).toMatchObject({
        mainRendered: true,
        accessible: true,
      });
      expect(Date.parse(session.record.desktopHandoffVerifiedAt)).toBeGreaterThanOrEqual(
        Date.parse(session.record.readingNavigationCompletedAt),
      );
      expect(statuses.some((message) => message.includes("浏览器继续保留"))).toBe(fallback);
      await info.attach("real-startup-pages", {
        body: Buffer.from(
          JSON.stringify({
            guideUrl,
            startupUrl: session.record.startupUrl,
            requestedReadingUrl: session.record.requestedReadingUrl,
            readingUrl: session.reading.url(),
            fallback,
            headless: session.record.headless,
            actualTabs: actual.tabs.length,
            activeGuideId: guide.tabId,
            pairedAutomatically: false,
            nativePanelCreatedAutomatically: false,
            evidenceScope: "真实随包启动、首装教学和文档降级；配对与读写另由连接业务测试验证",
          }),
        ),
        contentType: "application/json",
      });
    } catch (error) {
      failure = error;
      if (session)
        for (const [label, page] of [
          ["manager", session.workspace],
          ["desktop", session.desktopPage],
        ])
          if (page && !page.isClosed())
            try {
              await info.attach(label, { body: await page.screenshot(), contentType: "image/png" });
            } catch {
              // 保留最初的失败。
            }
    } finally {
      try {
        await session?.close();
      } catch (error) {
        failure ||= error;
      }
      if (slow)
        await new Promise((resolve) => {
          slow.close(resolve);
          slow.closeAllConnections();
        });
    }
    try {
      if (failure) throw failure;
      expect(session.record.focus.complete).toBe(true);
      expect(session.record.focus.violations).toEqual([]);
      expect(session.record.background.violations).toEqual([]);
      expect(session.record.cleanupErrors).toEqual([]);
      expect(session.record.productionBytesUnchanged).toBe(true);
      session.record.startupScenarioPassed = true;
    } finally {
      session?.saveEvidence();
    }
  });
}
