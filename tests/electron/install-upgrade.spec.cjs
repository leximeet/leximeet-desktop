const fs = require("node:fs");
const path = require("node:path");
const { test, expect } = require("../helpers/electron-fixture.cjs");
const { compareVersion } = require("../helpers/versions.cjs");
const { expectPreservedSettings } = require("../helpers/upgrade-settings.cjs");
const { createInstallation, assertInstaller } = require("../../scripts/lib/installer.cjs");

test("安装升级：旧安装产物写入 → 同位置替换新版 → 资料保留与再次写入", async ({
  desktopFactory,
}, testInfo) => {
  test.setTimeout(240000);
  const oldInstaller = process.env.LEXIMEET_PREVIOUS_INSTALLER;
  const newInstaller = process.env.LEXIMEET_INSTALLER;
  assertInstaller(oldInstaller);
  assertInstaller(newInstaller);
  expect(fs.realpathSync(newInstaller), "必须提供两个真实不同版本的安装产物").not.toBe(
    fs.realpathSync(oldInstaller),
  );
  const installation = createInstallation();
  const profileDir = desktopFactory.newProfile();
  let desktop;
  try {
    let executablePath = installation.install(oldInstaller);
    desktop = await desktopFactory.start({ executablePath, profileDir });
    const oldVersion = await desktop.app.evaluate(({ app }) => app.getVersion());
    await desktop.page.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "capture",
        word: "preserve",
        note: "安装替换后应保留的个人理解",
        context: "An installer must preserve the personal library.",
      }),
    );
    await desktop.page.evaluate(() => window.leximeet.settings({ theme: "dark" }));
    const before = await desktop.snapshot();
    await desktop.close();
    desktop = null;
    const backup = testInfo.outputPath("before-installer-upgrade.sqlite");
    fs.copyFileSync(path.join(profileDir, "core/leximeet.sqlite"), backup);
    await testInfo.attach("升级前测试库冷备份", {
      path: backup,
      contentType: "application/vnd.sqlite3",
    });
    // profile 在独立位置保持不变，安装器仅替换 fixture 创建的程序目录。
    executablePath = installation.install(newInstaller);
    desktop = await desktopFactory.start({ executablePath, profileDir, poisonHostJava: true });
    const newVersion = await desktop.app.evaluate(({ app }) => app.getVersion());
    expect(
      compareVersion(newVersion, oldVersion),
      `${oldVersion} → ${newVersion} 必须升级到更高版本`,
    ).toBeGreaterThan(0);
    const restored = await desktop.snapshot();
    for (const key of ["words", "encounters", "books", "wordBooks", "wordDetails"])
      expect(restored[key], `安装替换保留 ${key}`).toEqual(before[key]);
    expectPreservedSettings(expect, before.settings, restored.settings);
    await desktop.page.evaluate(() =>
      window.leximeet.desktopCommand({
        action: "collect",
        word: "installed",
        note: "新安装应用继续记录",
      }),
    );
    await desktop.close();
    desktop = null;
    desktop = await desktopFactory.start({ executablePath, profileDir, poisonHostJava: true });
    expect((await desktop.snapshot()).words.map((word) => word.word).sort()).toEqual([
      "installed",
      "preserve",
    ]);
    await testInfo.attach("安装升级证据", {
      body: Buffer.from(
        JSON.stringify({
          oldVersion,
          newVersion,
          platform: process.platform,
          scope:
            process.platform === "win32"
              ? "真实NSIS静默升级"
              : process.platform === "darwin"
                ? "DMG挂载复制与应用替换"
                : "AppImage提取载荷替换（不含FUSE）",
        }),
      ),
      contentType: "application/json",
    });
  } finally {
    // 即使断言失败，也先关闭应用及 Java，再卸载/移除本例安装目录。
    try {
      if (desktop) await desktop.close();
    } finally {
      try {
        installation.cleanup();
      } finally {
        await testInfo.attach("installer-log", {
          body: Buffer.from(JSON.stringify(installation.events, null, 2)),
          contentType: "application/json",
        });
      }
    }
  }
});
