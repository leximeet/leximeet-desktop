const test = require("node:test"),
  assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { StudyNotifications } = require("../../electron/services/study-notifications.cjs");
class Notice extends EventEmitter {
  static isSupported() {
    return true;
  }
  constructor(options) {
    super();
    this.options = options;
    this.id = options.id;
  }
  show() {
    this.emit("show");
  }
  close() {}
}
const q = (mode) => ({
  id: "one",
  wordId: "word",
  word: "alpha",
  meaning: "字母",
  mode,
  expiresAt: new Date(Date.now() + 60000).toISOString(),
  options: [
    { id: "word", text: "字母" },
    { id: "wrong", text: "错误" },
  ],
  context: "This is _____.",
});
const flush = () => new Promise((r) => setImmediate(r));
test("六模式使用原生按钮或回复；选择、拼写、音频完成后答题统一提交", async () => {
  for (const mode of ["word-list", "meaning-choice", "copy", "recall", "listening", "cloze"]) {
    const calls = [];
    let plays = 0;
    const notices = new StudyNotifications({
      Notification: Notice,
      platform: "darwin",
      play: async () => {
        plays++;
      },
      request: async (input) => {
        calls.push(input);
        return { correct: true, familiarity: { score: 12 } };
      },
    });
    let notice = notices.show(q(mode));
    if (mode === "listening") {
      notice.emit("action", { actionIndex: 0 });
      await flush();
      assert.equal(plays, 1);
      assert.equal(calls.length, 0);
      notice = notices.notices.get("one").notice;
    }
    if (["word-list", "meaning-choice"].includes(mode)) notice.emit("action", { actionIndex: 0 });
    else {
      assert.equal(notice.options.hasReply, true);
      notice.emit("reply", { reply: "alpha" });
    }
    await flush();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].action, "answerReminderQuestion");
    assert.equal(notices.notices.size, 0);
    notices.close();
  }
});
test("关闭、投递失败和空回复均不计分；重复回调结算一次", async () => {
  let writes = 0;
  const adapter = new StudyNotifications({
    Notification: Notice,
    platform: "darwin",
    request: async () => {
      writes++;
      await flush();
      return { correct: true, familiarity: { score: 11 } };
    },
  });
  const notice = adapter.show(q("recall"));
  notice.emit("close");
  notice.emit("failed");
  notice.emit("reply", { reply: "" });
  await flush();
  assert.equal(writes, 0);
  assert.equal(adapter.status.state, "failed");
  notice.emit("reply", { reply: "alpha" });
  notice.emit("reply", { reply: "alpha" });
  await flush();
  await flush();
  assert.equal(writes, 1);
  adapter.close();
});
test("恢复通知只绑定已投递的题目，过期题目移除；不重复 show 或发新题", async () => {
  const question = q("copy"),
    notice = new Notice({ id: "study-one" });
  notice.hasReply = true;
  let shown = 0;
  notice.show = () => shown++;
  Notice.getHistory = async () => [notice];
  const adapter = new StudyNotifications({
    Notification: Notice,
    platform: "darwin",
  });
  await adapter.restore([question]);
  assert.equal(shown, 0);
  assert.equal(adapter.notices.size, 1);
  adapter.close();
  delete Notice.getHistory;
});
test("能力不足或选定模式不可出题时不静默改模式，也不弹出窗口", async () => {
  let opened = false;
  const adapter = new StudyNotifications({
    Notification: Notice,
    platform: "linux",
    open: () => {
      opened = true;
    },
    request: async (input) => {
      assert.deepEqual(input.supportedModes, []);
      return { unavailable: "当前系统不支持所选方式" };
    },
  });
  assert.equal(await adapter.issue(), false);
  assert.equal(opened, false);
  assert.equal(adapter.status.state, "unavailable");
});

test("停用后迟到的出题和音频完成不能复活通知", async () => {
  let finishIssue, finishAudio;
  const adapter = new StudyNotifications({
    Notification: Notice,
    platform: "darwin",
    request: () =>
      new Promise((resolve) => {
        finishIssue = resolve;
      }),
    play: () =>
      new Promise((resolve) => {
        finishAudio = resolve;
      }),
  });
  const issuing = adapter.issue();
  adapter.close();
  finishIssue(q("copy"));
  assert.equal(await issuing, false);
  assert.equal(adapter.notices.size, 0);
  const notice = adapter.show(q("listening"));
  notice.emit("action", { actionIndex: 0 });
  adapter.close();
  finishAudio();
  await flush();
  assert.equal(adapter.notices.size, 0);
});
