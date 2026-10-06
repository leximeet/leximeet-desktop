const fs = require("node:fs");
const path = require("node:path");
const { test, expect, requireExecutable } = require("../helpers/electron-fixture.cjs");

const { compareVersion } = require("../helpers/versions.cjs");
const { expectPreservedSettings } = require("../helpers/upgrade-settings.cjs");

test("版本替换：旧包写入 → 备份 → 新包读取并继续写入 → 再次重启", async ({
  desktopFactory,
}, testInfo) => {
  const previousExecutable = requireExecutable(
    process.env.LEXIMEET_UPGRADE_FROM,
    "LEXIMEET_UPGRADE_FROM",
  );
  const candidateExecutable = requireExecutable(
    process.env.LEXIMEET_PACKAGED_EXECUTABLE,
    "LEXIMEET_PACKAGED_EXECUTABLE",
  );
  expect(candidateExecutable, "旧包与候选包不能是同一个文件").not.toBe(previousExecutable);
  const profileDir = desktopFactory.newProfile();
  // 老版本允许使用其原有 Java 选择机制；候选包必须证明内嵌运行时已经可用。
  let desktop = await desktopFactory.start({ executablePath: previousExecutable, profileDir });
  expect(await desktop.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  const previousVersion = await desktop.app.evaluate(({ app }) => app.getVersion());
  expect((await desktop.snapshot()).words).toEqual([]);
  const created = await desktop.page.evaluate(async () => {
    const snapshot = await window.leximeet.desktopCommand({
      action: "createBook",
      name: "升级前词本",
    });
    const bookId = snapshot.books.find((book) => book.name === "升级前词本").id;
    await window.leximeet.desktopCommand({
      action: "capture",
      word: "continuity",
      context: "Continuity keeps the learning record through an upgrade.",
      note: "升级前的个人理解",
      bookIds: [bookId],
    });
    return {
      bookId,
      detail: await window.leximeet.desktopQuery({ kind: "detail", wordId: "continuity" }),
    };
  });
  await desktop.page.evaluate(() => window.leximeet.settings({ theme: "dark" }));
  const backup = await desktop.page.evaluate(() => window.leximeet.exportData());
  expect(backup).toMatchObject({
    format: "leximeet-backup",
    version: 100,
    schemaVersion: 100,
    encoding: "sqlite-base64",
  });
  expect(Buffer.from(backup.data, "base64").subarray(0, 16).toString()).toBe("SQLite format 3\0");
  const before = await desktop.snapshot();
  await desktop.close();
  // SQLite 已退出，记录升级前冷备份；备份只含本例生成的虚拟资料。
  const databaseBackup = testInfo.outputPath("pre-upgrade.sqlite");
  fs.copyFileSync(path.join(profileDir, "core/leximeet.sqlite"), databaseBackup);
  await testInfo.attach("pre-upgrade-database", {
    path: databaseBackup,
    contentType: "application/vnd.sqlite3",
  });
  await testInfo.attach("pre-upgrade-export", {
    body: Buffer.from(JSON.stringify(backup, null, 2)),
    contentType: "application/json",
  });

  desktop = await desktopFactory.start({
    executablePath: candidateExecutable,
    profileDir,
    poisonHostJava: true,
  });
  expect(await desktop.app.evaluate(({ app }) => app.isPackaged)).toBe(true);
  const candidateVersion = await desktop.app.evaluate(({ app }) => app.getVersion());
  expect(
    compareVersion(candidateVersion, previousVersion),
    `${previousVersion} → ${candidateVersion} 必须是更高版本`,
  ).toBeGreaterThan(0);
  const after = await desktop.snapshot();
  for (const key of ["words", "encounters", "books", "wordBooks", "wordDetails"])
    expect(after[key], `升级保留 ${key}`).toEqual(before[key]);
  expectPreservedSettings(expect, before.settings, after.settings);
  await expect(desktop.page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(after.words[0].id).toBe(created.detail.id);
  // 仅验收同一数据格式的应用替换；LMCP 开发期不承担跨 schema 迁移。
  expect(after.wordBooks).toContainEqual({
    wordId: after.words[0].id,
    bookId: created.bookId,
  });
  const restoredDetail = await desktop.page.evaluate(() =>
    window.leximeet.desktopQuery({ kind: "detail", wordId: "continuity" }),
  );
  expect(restoredDetail.note).toBe(created.detail.note);
  expect(restoredDetail.books).toEqual(created.detail.books);
  await desktop.page.evaluate(() =>
    window.leximeet.desktopCommand({
      action: "capture",
      word: "upgrade",
      context: "The upgrade can still write new records.",
    }),
  );
  await desktop.close();
  desktop = await desktopFactory.start({
    executablePath: candidateExecutable,
    profileDir,
    poisonHostJava: true,
  });
  expect((await desktop.snapshot()).words.map((word) => word.word).sort()).toEqual([
    "continuity",
    "upgrade",
  ]);
  await testInfo.attach("upgrade-evidence", {
    body: Buffer.from(
      JSON.stringify(
        {
          previousVersion,
          candidateVersion,
          previousExecutable,
          candidateExecutable,
          scope: "真实二进制替换与资料兼容；不代表自动下载更新、安装器替换或签名已验证。",
        },
        null,
        2,
      ),
    ),
    contentType: "application/json",
  });
});
