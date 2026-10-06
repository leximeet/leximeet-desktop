const { test, expect } = require("../helpers/electron-fixture.cjs");

// 原生套件跨平台运行；仅 macOS 默认关闭窗口后隐藏，并支持 Dock activate。
test.skip(process.platform !== "darwin", "macOS 专属窗口生命周期");
test("macOS：关闭保留原窗口，静默验收的 activate 不抢焦点", async ({ desktopFactory }) => {
  const desktop = await desktopFactory.start();
  const id = await desktop.app.evaluate(({ BrowserWindow }, mainWindowId) => {
    const win = BrowserWindow.getAllWindows().find((item) => item.id === mainWindowId);
    const id = win.id;
    win.close();
    return id;
  }, desktop.mainWindowId);
  expect(
    await desktop.app.evaluate(({ BrowserWindow }, mainWindowId) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.id === mainWindowId);
      return { exists: Boolean(win), destroyed: win?.isDestroyed(), visible: win?.isVisible() };
    }, desktop.mainWindowId),
  ).toEqual({ exists: true, destroyed: false, visible: false });
  await desktop.app.evaluate(({ app }) => app.emit("activate"));
  expect(
    await desktop.app.evaluate(({ BrowserWindow }, mainWindowId) => {
      const win = BrowserWindow.getAllWindows().find((item) => item.id === mainWindowId);
      return { id: win.id, visible: win.isVisible(), focused: win.isFocused() };
    }, desktop.mainWindowId),
  ).toEqual({ id, visible: false, focused: false });
});
