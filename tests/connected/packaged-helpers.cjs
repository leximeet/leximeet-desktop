"use strict";
const { expect } = require("@playwright/test");
const gate = require("../../scripts/lib/connected-readiness.cjs");
const { startPackagedLab } = require("../../scripts/accept-connected.cjs");
const {
  createConnectionUi,
} = require("../../../plugin/leximeet-browser/tests/connected/connection-ui.mjs");
// 只映射两条真实驱动的资料位置，绝不替换网络、Native 或业务 API。
function adaptSession(session) {
  Object.defineProperties(session, {
    profileDir: { get: () => session.record.profileRoot },
    evidence: { get: () => session.record },
  });
  return session;
}
// 直接使用用户入口与真实 SQLite，不通过假 API 补数据或仅以旧三场通过宣称采集可用。
async function withLab(info, run) {
  const session = await startPackagedLab(gate.checkReadiness(), {
    headless: true,
    prepare: false,
    poisonHostJava: true,
    packageDirectory: process.env.LEXIMEET_CONNECTED_PACKAGE_ROOT,
    outputDir: info.outputPath("evidence"),
    onStatus: () => {},
  });
  let failure;
  try {
    adaptSession(session);
    await run(session);
  } catch (error) {
    failure = error;
    for (const [name, page] of [
      ["reading", session.reading],
      ["manager", session.workspace],
      ["desktop", session.desktopPage],
    ]) {
      if (!page || page.isClosed()) continue;
      try {
        await info.attach(name, {
          body: await page.screenshot(),
          contentType: "image/png",
        });
      } catch {
        // 保留业务错误。
      }
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
}
async function facts(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      // 资料结构由真实扩展初始化；只读当前库，避免测试写死旧版本造成降级错误。
      const request = indexedDB.open("leximeet-personal-v1");
      request.onupgradeneeded = () => {
        request.transaction.abort();
        reject(new Error("真实扩展尚未初始化个人资料，测试不得代建数据库"));
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const names = ["meta", "words", "encounters", "reviews", "practice", "notebooks"];
    const tx = db.transaction(names);
    const get = (name, key) =>
      new Promise((resolve, reject) => {
        const request = key ? tx.objectStore(name).get(key) : tx.objectStore(name).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const values = await Promise.all([
      get("meta", "book"),
      get("meta", "settings"),
      get("meta", "workspace"),
      get("meta", "checkpoints"),
      get("meta", "studyPlan"),
      ...names.slice(1).map((name) => get(name)),
    ]);
    db.close();
    const keys = ["book", "settings", "workspace", "checkpoints", "plan", ...names.slice(1)];
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]));
  });
}
module.exports = {
  withLab,
  facts,
  adaptSession,
  ...createConnectionUi(expect),
};
