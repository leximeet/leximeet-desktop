"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { DesktopNavigation } = require("../../electron/services/desktop-navigation.cjs");
function fixture(timeoutMs = 50) {
  const sent = [],
    frame = {};
  const contents = {
    mainFrame: frame,
    isDestroyed: () => false,
    send: (channel, value) => sent.push({ channel, value }),
  };
  const win = { isDestroyed: () => false, webContents: contents };
  let shown = 0;
  const navigation = new DesktopNavigation({
    getWindow: () => win,
    showWindow: () => shown++,
    timeoutMs,
  });
  return { sent, contents, frame, navigation, shown: () => shown };
}
test("固定目标在主页面真正确认后才返回成功，不把 send 当成打开", async () => {
  const f = fixture(),
    params = { target: "settings" };
  const pending = f.navigation.open(params, {
    navigationDelivery: { target: "settings" },
  });
  assert.equal(f.shown(), 1);
  assert.equal(f.sent[0].value.page, "settings");
  const value = { requestId: f.sent[0].value.requestId, opened: true };
  f.navigation.acknowledge({ sender: {}, senderFrame: f.frame }, value);
  assert.equal(f.navigation.pending.size, 1);
  f.navigation.acknowledge({ sender: f.contents, senderFrame: {} }, value);
  assert.equal(f.navigation.pending.size, 1);
  f.navigation.acknowledge({ sender: f.contents, senderFrame: f.frame }, value);
  assert.equal(await pending, true);
});
test("缺少确认、退出和 Renderer 拒绝都返回未打开", async () => {
  const f = fixture(10);
  assert.equal(
    await f.navigation.open({ target: "plan" }, { navigationDelivery: { target: "plan" } }),
    false,
  );
  const pending = f.navigation.open(
    { target: "library" },
    { navigationDelivery: { target: "library" } },
  );
  f.navigation.close();
  assert.equal(await pending, false);
  assert.equal(f.navigation.pending.size, 0);
});
test("WordRef 路由只搬运内部定位ID，不接收任意地址和私有传输字段", async () => {
  const f = fixture();
  for (const [params, delivery] of [
    [{ target: "shell" }, { target: "shell" }],
    [{ target: "word" }, { target: "word" }],
    [{ target: "plan" }, { target: "settings" }],
  ])
    assert.equal(await f.navigation.open(params, { navigationDelivery: delivery }), false);
  assert.equal(f.sent.length, 0);
  const pending = f.navigation.open(
    { target: "word", word: { kind: "dictionary" } },
    {
      navigationDelivery: {
        target: "word",
        uiWordId: "entry_uuid",
        uiSearchTerm: "cancel",
        deliveryToken: "private",
      },
    },
  );
  assert.equal(f.sent[0].value.scope, "dictionary");
  assert.equal(f.sent[0].value.wordId, "entry_uuid");
  assert.equal(f.sent[0].value.searchTerm, "cancel");
  assert.equal(JSON.stringify(f.sent).includes("private"), false);
  f.navigation.acknowledge(
    { sender: f.contents, senderFrame: f.frame },
    { requestId: f.sent[0].value.requestId, opened: false },
  );
  assert.equal(await pending, false);
});
