"use strict";
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test, expect } = require("@playwright/test");
const shared = require("./packaged-helpers.cjs");
const {
  captureRows,
} = require("../../../plugin/leximeet-browser/tests/connected/capture-scenarios.mjs");

// Source 与真实 app 使用相同业务断言；必须显式选择 Source，包级绝不静默降级。
async function withPolicyLab(info, run) {
  if (process.env.LEXIMEET_CONNECTED_POLICY_SOURCE !== "1") return shared.withLab(info, run);
  const { startConnectedLab } = await import(
    "../../../plugin/leximeet-browser/scripts/launch-connected-lab.mjs"
  );
  const lab = await startConnectedLab({
    headless: true,
    readingUrl: "local",
    outputDir: info.outputPath("lab"),
    onStatus: () => {},
  });
  let failure;
  try {
    await run(lab);
  } catch (error) {
    failure = error;
    for (const [name, page] of [
      ["reading", lab.reading],
      ["manager", lab.workspace],
      ["desktop", lab.desktopPage],
    ]) {
      if (!page || page.isClosed()) continue;
      try {
        await info.attach(name, { body: await page.screenshot(), contentType: "image/png" });
      } catch {
        // 诊断不代替原始错误。
      }
    }
  } finally {
    try {
      await lab.close();
    } catch (error) {
      failure ||= error;
    }
  }
  try {
    if (failure) throw failure;
    expect(lab.evidence.manifestUnchanged).toBe(true);
    expect(lab.evidence.productionBytesUnchanged).toBe(true);
    expect(lab.evidence.focus.complete).toBe(true);
    expect(lab.evidence.focus.violations).toEqual([]);
    expect(lab.evidence.desktopBackground.violations).toEqual([]);
    expect(lab.evidence.cleanupErrors).toEqual([]);
    expect(lab.evidence.profileRemoved).toBe(true);
    lab.evidence.testScenarioPassed = true;
  } finally {
    lab.saveEvidence();
    await info.attach("policy-source-boundary", {
      body: Buffer.from(JSON.stringify(lab.evidence, null, 2)),
      contentType: "application/json",
    });
  }
}

function receipts(lab) {
  const db = new DatabaseSync(path.join(lab.profileDir, "core/leximeet.sqlite"), {
    readOnly: true,
  });
  try {
    return {
      workspaceRevision: db.prepare("SELECT value FROM lmcp_meta WHERE key='revision'").get()
        ?.value,
      operations: db
        .prepare(
          "SELECT mutation_id AS mutationId,status,result FROM lmcp_operations WHERE method='recordEncounter' ORDER BY created_at,mutation_id",
        )
        .all()
        .map((row) => ({ ...row, result: JSON.parse(row.result) })),
    };
  } finally {
    db.close();
  }
}
const policy = (page) =>
  page.evaluate(async () => {
    const response = await chrome.runtime.sendMessage({
      channel: "leximeet",
      action: "capture-policy",
      data: {},
    });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  });
const notices = (lab) =>
  lab.desktopPage.evaluate(
    async () => (await window.leximeet.runtime()).pluginCaptureNotifications.sentCount,
  );

test("真实双端采集规则：封存A偏好、Desktop单句脱敏限长、跨入口去重回执与断开恢复", async ({}, info) => {
  await withPolicyLab(info, async (lab) => {
    const manager = lab.workspace;
    const skip = manager.getByRole("button", { name: "跳过引导", exact: true });
    if (await skip.count()) await skip.click();
    await manager.getByRole("button", { name: "设置", exact: true }).click();
    const days = manager.getByRole("spinbutton", { name: "相同语境去重天数", exact: true });
    await days.fill("3");
    await days.blur();
    await expect.poll(() => policy(manager)).toMatchObject({ duplicateWindowDays: 3 });
    await manager.getByRole("checkbox", { name: "敏感内容替换为 xxx", exact: true }).uncheck();
    await expect.poll(() => policy(manager)).toMatchObject({ sensitiveRedactionEnabled: false });
    const length = manager.getByRole("spinbutton", { name: "单句语境长度上限", exact: true });
    await length.fill("900");
    await length.blur();
    const originalPolicy = {
      duplicateWindowDays: 3,
      sensitiveRedactionEnabled: false,
      contextMaxLength: 900,
    };
    await expect.poll(() => policy(manager)).toEqual(originalPolicy);
    const originalA = await shared.facts(manager);
    await shared.prepareDesktopSettings(lab);
    const book = await lab.desktopPage.evaluate(async () => {
      const created = await window.leximeet.desktopCommand({
        action: "createBook",
        name: "采集规则 B",
      });
      const book = created.books.find((item) => item.name === "采集规则 B");
      await window.leximeet.desktopCommand({
        action: "collect",
        word: "alpha",
        note: "桌面笔记不被重复覆盖",
        bookIds: [book.id],
      });
      return book;
    });
    expect(
      (await lab.desktopPage.evaluate(() => window.leximeet.desktopState())).settings,
    ).toMatchObject({
      captureDuplicateWindowDays: 7,
      captureSensitiveRedactionEnabled: true,
      captureContextMaxLength: 500,
    });
    const noticesBefore = await notices(lab);
    await shared.pairThroughUi(lab);
    expect(await shared.facts(manager)).toMatchObject({ settings: originalA.settings });
    expect(shared.independentFacts(await shared.facts(manager))).toEqual(
      shared.independentFacts(originalA),
    );
    // 这是本轮随机回环网站的一段真实 DOM；不拦截 Native、业务 API 或判题返回。
    await lab.reading.evaluate(() => {
      const p = document.createElement("p");
      p.dataset.testid = "policy-context";
      p.append("Intro. 🙂 Contact me@example.com about ");
      const word = document.createElement("span");
      word.dataset.testid = "policy-word";
      word.textContent = "alpha";
      p.append(
        word,
        " on 13800138000, token=privatefixturetoken ",
        "carefully ".repeat(70),
        ". Tail.",
      );
      document.querySelector("main").replaceChildren(p);
    });
    const panel = await lab.openPanel();
    await expect(panel.getByRole("contentinfo", { name: "运行状态" })).toContainText(
      "已连接桌面端",
    );
    await panel.getByRole("button", { name: "采集", exact: true }).click();
    await expect(panel.getByRole("button", { name: "结束采集", exact: true })).toBeVisible();
    await lab.reading.getByTestId("policy-word").click();
    await expect(panel.locator(".lm-detail h2")).toHaveText("alpha");
    const drafts = await manager.evaluate(async () =>
      Object.values(
        (await chrome.storage.session.get("standaloneDrafts")).standaloneDrafts || {},
      ).flat(),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0].capturePolicy).toEqual({
      duplicateWindowDays: 7,
      sensitiveRedactionEnabled: true,
      contextMaxLength: 500,
    });
    await panel.getByRole("combobox", { name: "选择单词本", exact: true }).selectOption(book.id);
    await panel.getByRole("button", { name: "加入单词本", exact: true }).click();
    await expect.poll(() => captureRows(lab).length).toBe(1);
    await expect.poll(() => notices(lab)).toBe(noticesBefore + 1);
    const first = captureRows(lab)[0];
    expect(first.word).toBe("alpha");
    expect(first.sourceKind).toBe("web");
    expect(first.sourceUrl).toBe(lab.reading.url());
    expect(first.note).toBe("桌面笔记不被重复覆盖");
    expect(first.eventEntity.source.kind).toBe("web");
    expect(first.wordRef).toMatchObject({
      kind: "dictionary",
      release: "0.0.3",
      entrySchema: "leximeet.entry.v2",
    });
    expect(first.eventEntity.word).toEqual(first.wordRef);
    expect(first.originalSentence).toContain("xxx");
    expect(first.originalSentence).toContain("🙂");
    expect(first.originalSentence).not.toMatch(
      /me@example\.com|13800138000|privatefixturetoken|Intro|Tail/,
    );
    expect(first.originalSentence.length).toBeLessThanOrEqual(500);
    expect(first.eventEntity.occurrenceRanges).toHaveLength(1);
    for (const range of first.eventEntity.occurrenceRanges)
      expect(first.originalSentence.slice(range.start, range.end)).toBe("alpha");
    const prior = receipts(lab);
    expect(prior.operations).toHaveLength(1);
    expect(prior.operations[0].result.captureStatus).toBe("created");
    expect(prior.operations[0].result.entity.entityId).toBe(first.eventId);
    const detailBefore = await shared.desktopQuery(lab, { kind: "detail", wordId: "alpha" });
    expect(first.wordRef.entryId).toBe(detailBefore.entry.entry_id);

    // 全部草稿成功保存后，生产流程已结束当次采集；先确认真实状态再切换入口。
    await expect(panel.getByRole("button", { name: "开始采集", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "结束采集", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "遇见", exact: true }).click();
    await panel.getByRole("button", { name: "分析本页", exact: true }).click();
    await expect(panel.getByRole("region", { name: "遇见单词列表" })).toContainText(/alpha/i);
    await lab.reading.getByTestId("policy-word").hover();
    const card = lab.reading.locator("leximeet-page-ui .card");
    await expect(card.locator("button.capture")).toHaveText("采集");
    await card.locator("button.capture").click();
    await expect(card.locator("button.capture")).toHaveText("已记录");
    const after = receipts(lab);
    expect(after.operations).toHaveLength(2);
    expect(new Set(after.operations.map((item) => item.mutationId)).size).toBe(2);
    const duplicate = after.operations.find(
      (item) => item.result.captureStatus === "duplicate-context",
    );
    expect(duplicate).toBeTruthy();
    // LMCP EntityRecord 的稳定主键是 entityId；SQLite encounter.id 是同一事件的存储投影。
    expect(duplicate.result.entity.entityId).toBe(first.eventId);
    expect(after.workspaceRevision).toBe(prior.workspaceRevision);
    expect(captureRows(lab)).toEqual([first]);
    expect(await notices(lab)).toBe(noticesBefore + 1);
    const detailAfter = await shared.desktopQuery(lab, { kind: "detail", wordId: "alpha" });
    expect(detailAfter.note).toBe(detailBefore.note);
    expect(detailAfter.books).toEqual(detailBefore.books);
    // 查询的 asOf 是当前真实时刻，不等同于学习事件；只核对学习状态和分数未变化。
    expect(detailAfter.familiarity.score).toBe(detailBefore.familiarity.score);
    expect(detailAfter.familiarity.status).toBe(detailBefore.familiarity.status);
    await shared.disconnectThroughUi(manager);
    await expect
      .poll(() => shared.connection(manager))
      .toMatchObject({ mode: "independent", status: "independent" });
    await expect(manager.getByRole("navigation", { name: "工作区导航" })).toBeVisible();
    expect(shared.independentFacts(await shared.facts(manager))).toEqual(
      shared.independentFacts(originalA),
    );
    expect(await policy(manager)).toEqual(originalPolicy);
    expect(captureRows(lab)).toEqual([first]);
    await info.attach("actual-policy-receipts", {
      body: Buffer.from(
        JSON.stringify(
          {
            originalPolicy,
            first,
            prior,
            after,
            notices: await notices(lab),
            restoredPolicy: await policy(manager),
          },
          null,
          2,
        ),
      ),
      contentType: "application/json",
    });
    (lab.evidence || lab.record).capturePolicyAcceptance = {
      actualNativeCapture: true,
      sealedIndependentPolicy: true,
      singleSentence: true,
      redacted: true,
      length500: true,
      utf16Ranges: true,
      separateMutationDuplicateOldEntity: true,
      duplicateHasNoWorkspaceOrNotificationChange: true,
      explicitDisconnectRestoresA: true,
    };
  });
});
