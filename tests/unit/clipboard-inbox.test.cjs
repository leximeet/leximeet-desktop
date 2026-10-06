const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { NativeCaptureService } = require("../../electron/services/native-capture.cjs");
const { ClipboardInbox } = require("../../electron/services/clipboard-inbox.cjs");

function fixture({ supported = true, fail = false } = {}) {
  let time = 1000,
    sequence = 0,
    fallbacks = 0;
  const timers = new Map(),
    saves = [],
    notices = [];
  class Notification extends EventEmitter {
    static isSupported() {
      return supported;
    }
    constructor(options) {
      super();
      this.options = options;
      this.closed = 0;
      notices.push(this);
    }
    show() {
      this.emit(fail ? "failed" : "show");
    }
    close() {
      this.closed++;
      this.emit("close", { reason: "applicationHidden" });
    }
  }
  const inbox = new ClipboardInbox({
    Notification,
    match: async (words) => ({
      goal: "exam:test",
      matches: words.map((word) => ({ word, wordId: word })),
    }),
    save: async (data) => saves.push(data),
    fallback: () => fallbacks++,
    now: () => time,
    setTimer: (callback, duration) => {
      const id = ++sequence;
      timers.set(id, { callback, at: time + duration });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });
  inbox.apply({ clipboardCaptureEnabled: true });
  return {
    inbox,
    saves,
    notices,
    get fallbacks() {
      return fallbacks;
    },
    advance: async (milliseconds) => {
      time += milliseconds;
      for (const [id, timer] of [...timers])
        if (timer.at <= time) {
          timers.delete(id);
          timer.callback();
        }
      await inbox.queue.catch(() => {});
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("三个词各有系统通知，10 秒到时撤回并各保存一次原句", async () => {
  const f = fixture();
  await f.inbox.accept({
    text: "Apple banana orange.",
    words: ["apple", "banana", "orange"],
  });
  assert.equal(f.notices.length, 3);
  assert.ok(f.notices.every((notice) => notice.options.actions.length === 2));
  await f.advance(9999);
  assert.equal(f.saves.length, 0);
  await f.advance(1);
  assert.equal(f.saves.length, 3);
  assert.ok(f.saves.every((data) => data.context === "Apple banana orange."));
  assert.ok(f.notices.every((notice) => notice.closed === 1));
  assert.equal(f.inbox.snapshot().items.length, 0);
});
test("Core 返回安全命中句子才放入队列，重复语境及仍在决策的句子不重复通知", async () => {
  const f = fixture();
  let received;
  f.inbox.match = async (words, text) => {
    received = text;
    return {
      goal: "exam:test",
      matches: [
        { word: "apple", wordId: "apple", context: "Apple xxx." },
        {
          word: "banana",
          wordId: "banana",
          context: "Banana xxx.",
          captureStatus: "duplicate-context",
        },
      ],
    };
  };
  await f.inbox.accept({
    text: "Apple private@example.test. More text.",
    words: ["apple", "banana"],
  });
  assert.equal(received, "Apple private@example.test. More text.");
  assert.equal(f.notices.length, 1);
  assert.equal(f.inbox.snapshot().items[0].context, "Apple xxx.");
  await f.inbox.accept({
    text: "Apple private@example.test. More text.",
    words: ["apple", "banana"],
  });
  assert.equal(f.notices.length, 1);
  await f.advance(10000);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].context, "Apple xxx.");
  f.inbox.cancel();
});
test("逐词拒绝、立即采集和系统关闭互不影响，重复 action 不重复保存", async () => {
  const f = fixture();
  await f.inbox.accept({
    text: "alpha beta gamma",
    words: ["alpha", "beta", "gamma"],
  });
  f.notices[0].emit("action", { actionIndex: 1 });
  f.notices[1].emit("action", { actionIndex: 0 });
  f.notices[1].emit("click");
  f.notices[2].emit("close", { reason: "userCanceled" });
  await f.advance(10000);
  assert.deepEqual(
    f.saves.map((data) => data.wordId),
    ["beta"],
  );
});
test("默认不采集的偏好只决定超时；点击采集仍能保存", async () => {
  const f = fixture();
  f.inbox.apply({ clipboardCaptureEnabled: true, clipboardAutoCollect: false });
  await f.inbox.accept({ text: "alpha beta", words: ["alpha", "beta"] });
  f.notices[1].emit("action", {}, 0);
  await f.advance(10000);
  assert.deepEqual(
    f.saves.map((data) => data.wordId),
    ["beta"],
  );
});
test("系统投递失败保留原项供明确恢复，不打开弹窗或开始倒计时", async () => {
  const f = fixture({ fail: true });
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  assert.equal(f.fallbacks, 0);
  assert.match(f.inbox.snapshot().error, /系统通知未送达/);
  f.notices[0].emit("show");
  f.inbox.ready();
  await f.advance(20000);
  assert.equal(f.saves.length, 0);
  assert.equal(f.inbox.snapshot().items.length, 1);
  assert.equal(f.inbox.snapshot().items[0].status, "failed");
  assert.equal(f.inbox.snapshot().deliveryRetryRequired, true);
});
test("显式弹窗模式不用系统通知，窗口就绪后才开始十秒决策", async () => {
  const f = fixture();
  f.inbox.apply({
    clipboardCaptureEnabled: true,
    clipboardReminderMode: "popup",
  });
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  assert.equal(f.notices.length, 0);
  assert.equal(f.fallbacks, 1);
  await f.advance(20000);
  assert.equal(f.saves.length, 0);
  f.inbox.ready();
  await f.advance(9999);
  assert.equal(f.saves.length, 0);
  await f.advance(1);
  assert.equal(f.saves.length, 1);
});
test("关闭识别取消倒计时与尚未开始的队列，不影响其他系统通知", async () => {
  const f = fixture();
  await f.inbox.accept({ text: "alpha beta", words: ["alpha", "beta"] });
  f.inbox.close();
  await f.advance(10000);
  assert.equal(f.saves.length, 0);
  assert.equal(f.inbox.snapshot().items.length, 0);
});
test("保存失败显示可见错误，不自动反复重试写入", async () => {
  const f = fixture();
  f.inbox.save = async () => {
    throw new Error("核心暂不可用");
  };
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  await f.advance(10000);
  assert.equal(f.inbox.snapshot().items[0].status, "failed");
  assert.match(f.inbox.snapshot().error, /核心暂不可用/);
  assert.equal(f.fallbacks, 0);
  const id = f.inbox.snapshot().items[0].id;
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1].options.actions[0].text, "重试采集");
  await f.advance(60000);
  assert.equal(f.notices.length, 2);
  // 再次匹配不能偷偷丢弃未知原操作并生成新 ID。
  f.inbox.save = async (data) => f.saves.push(data);
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  assert.equal(f.notices.length, 2);
  assert.equal(f.inbox.snapshot().items.length, 1);
  assert.equal(f.inbox.snapshot().items[0].status, "failed");
  assert.equal(f.inbox.snapshot().items[0].id, id);
  f.notices[1].emit("click");
  f.notices[1].emit("action", { actionIndex: 0 });
  await f.advance(10000);
  assert.equal(f.saves.length, 1);
  assert.equal(f.saves[0].operationId, id);
  assert.equal(f.inbox.snapshot().items.length, 0);
  assert.equal(f.inbox.snapshot().error, "");
});

test("原生失败后迟到的 show 与异步 close 不复活已取消的采集", async () => {
  const f = fixture({ fail: true });
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  f.notices[0].emit("show");
  f.notices[0].emit("close", {});
  await f.advance(20000);
  assert.equal(f.saves.length, 0);
  assert.equal(f.inbox.snapshot().items[0].status, "failed");
  f.inbox.ready();
  await f.advance(10000);
  assert.equal(f.saves.length, 0);
});

test("仅为 Core 匹配的目标词提醒，保存绑定目标和公共身份", async () => {
  const f = fixture();
  f.inbox.match = async () => ({
    goal: "exam:ielts",
    matches: [{ word: "apple", wordId: "entry-apple" }],
  });
  await f.inbox.accept({
    text: "Apple and outsideword.",
    words: ["apple", "and", "outsideword"],
  });
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].options.title, "保存 apple 的语境？");
  await f.advance(10000);
  assert.deepEqual(f.saves, [
    {
      action: "captureClipboard",
      goal: "exam:ielts",
      wordId: "entry-apple",
      context: "Apple and outsideword.",
      operationId: f.saves[0].operationId,
    },
  ]);
  assert.match(f.saves[0].operationId, /^[0-9a-f-]{36}$/);
});

test("未设目标或没有交集时不提醒、不打开窗口、不保存", async () => {
  const f = fixture();
  for (const goal of ["", "exam:ielts"]) {
    f.inbox.match = async () => ({ goal, matches: [] });
    await f.inbox.accept({ text: "outsideword", words: ["outsideword"] });
    await f.advance(10000);
  }
  assert.equal(f.notices.length, 0);
  assert.equal(f.fallbacks, 0);
  assert.deepEqual(f.saves, []);
});

test("目标变化撤回通知，同一目标的计划调整不撤回；迟到匹配不能复活旧目标", async () => {
  const f = fixture();
  await f.inbox.accept({ text: "alpha", words: ["alpha"] });
  f.inbox.setGoal("exam:test");
  assert.equal(f.inbox.snapshot().items.length, 1);
  let resolve;
  f.inbox.match = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.inbox.accept({ text: "beta", words: ["beta"] });
  f.inbox.setGoal("exam:other");
  resolve({ goal: "exam:test", matches: [{ word: "beta", wordId: "beta" }] });
  await pending;
  await f.advance(10000);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].closed, 1);
  assert.equal(f.inbox.snapshot().items.length, 0);
  assert.deepEqual(f.saves, []);
});

test("关闭识别丢弃未完成匹配，Core 不可用也不能退回全词提醒", async () => {
  const f = fixture();
  let resolve;
  f.inbox.match = () =>
    new Promise((done) => {
      resolve = done;
    });
  const pending = f.inbox.accept({ text: "alpha", words: ["alpha"] });
  f.inbox.apply({ clipboardCaptureEnabled: false });
  resolve({ goal: "exam:test", matches: [{ word: "alpha", wordId: "alpha" }] });
  await pending;
  f.inbox.apply({ clipboardCaptureEnabled: true });
  f.inbox.match = async () => {
    throw new Error("断开");
  };
  await f.inbox.accept({ text: "beta", words: ["beta"] });
  assert.match(f.inbox.snapshot().error, /学习目标匹配失败/);
  assert.equal(f.notices.length, 0);
  assert.deepEqual(f.saves, []);
});

test("首次并发匹配同一目标的两段语境都保留", async () => {
  const f = fixture(),
    resolvers = [];
  f.inbox.match = (words) =>
    new Promise((resolve) =>
      resolvers.push(() =>
        resolve({
          goal: "exam:test",
          matches: words.map((word) => ({ word, wordId: word })),
        }),
      ),
    );
  const first = f.inbox.accept({ text: "first alpha", words: ["alpha"] });
  const second = f.inbox.accept({ text: "second beta", words: ["beta"] });
  resolvers[0]();
  await first;
  resolvers[1]();
  await second;
  await f.advance(10000);
  assert.deepEqual(
    f.saves.map((data) => data.context),
    ["first alpha", "second beta"],
  );
});

test("生产 Native→Inbox 同文本轮询不重发，未知 ACK 通过原通知同 ID 显式恢复", async () => {
  const f = fixture(),
    attempts = [],
    receipts = new Map();
  let writes = 0;
  // 模拟响应丢失的传输副作用；真实 SQLite/HTTP 幂等由 Core 集成测试单独验证。
  f.inbox.save = async (data) => {
    attempts.push({ ...data });
    if (receipts.has(data.operationId)) return receipts.get(data.operationId);
    writes++;
    receipts.set(data.operationId, {
      clipboardAccepted: true,
      captureOperationReplayed: true,
    });
    throw new Error("HTTP 响应丢失");
  };
  const native = new NativeCaptureService({
    clipboard: { readText: () => "Alpha." },
    intervalMs: 60000,
    sendPreview: (preview) =>
      preview.source === "clipboard" ? f.inbox.accept(preview) : f.inbox.cancel(),
  });
  native.apply({ clipboardCaptureEnabled: true });
  try {
    await native.poll();
    await f.advance(10000);
    const id = f.inbox.snapshot().items[0].id;
    assert.equal(writes, 1);
    for (let i = 0; i < 5; i++) await native.poll();
    await f.advance(120000);
    assert.equal(attempts.length, 1);
    assert.equal(f.notices.length, 2);
    assert.equal(native.lastText, "Alpha.");
    await f.inbox.decide(id, true);
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[0], attempts[1]);
    assert.equal(writes, 1);
    assert.equal(f.inbox.snapshot().items.length, 0);
    await native.poll();
    assert.equal(f.notices.length, 2);
  } finally {
    native.close();
  }
});

test("明确预检读到新正文并拒绝后，普通轮询不会再为该正文建立新通知", async () => {
  const f = fixture();
  let text = "Alpha.";
  const native = new NativeCaptureService({
    clipboard: { readText: () => text },
    intervalMs: 60000,
    sendPreview: (preview) =>
      preview.source === "clipboard" ? f.inbox.accept(preview) : f.inbox.cancel(),
  });
  native.apply({ clipboardCaptureEnabled: true });
  try {
    await native.poll();
    await f.inbox.decide(f.inbox.snapshot().items[0].id, false);
    text = "Beta.";
    await native.retryPreview();
    await f.inbox.decide(f.inbox.snapshot().items[0].id, false);
    for (let i = 0; i < 5; i++) await native.poll();
    assert.equal(native.lastText, "Beta.");
    assert.equal(f.notices.length, 2);
    assert.equal(f.inbox.snapshot().items.length, 0);
    assert.equal(f.saves.length, 0);
  } finally {
    native.close();
  }
});

test("未知提交后预检已经查重也保留原项；显式设置重试只重发无倒计时确认", async () => {
  const f = fixture();
  f.inbox.save = async () => {
    throw new Error("结果未知");
  };
  await f.inbox.accept({ text: "Alpha.", words: ["alpha"] });
  await f.advance(10000);
  const id = f.inbox.snapshot().items[0].id;
  f.inbox.match = async () => ({ goal: "exam:test", matches: [] });
  await f.inbox.accept({ text: "Alpha.", words: ["alpha"] });
  f.inbox.retryFailedNotifications();
  assert.equal(f.inbox.snapshot().items[0].id, id);
  assert.equal(f.inbox.snapshot().items[0].expiresAt, 0);
  assert.equal(f.notices.length, 3);
  await f.advance(120000);
  assert.equal(f.notices.length, 3);
  assert.equal(f.inbox.snapshot().items[0].status, "failed");
  assert.equal(f.fallbacks, 0);
  await f.inbox.decide(id, false);
  assert.equal(f.inbox.snapshot().items.length, 0);
});

test("目标改变或关闭后迟到保存失败不复活原项/通知，原排队项可显式拒绝", async () => {
  for (const cancel of [(inbox) => inbox.setGoal("exam:other"), (inbox) => inbox.close()]) {
    const f = fixture();
    let reject;
    f.inbox.save = () =>
      new Promise((resolve, no) => {
        reject = no;
      });
    await f.inbox.accept({ text: "Alpha.", words: ["alpha"] });
    const pending = f.inbox.decide(f.inbox.snapshot().items[0].id, true);
    await new Promise(setImmediate);
    cancel(f.inbox);
    reject(new Error("迟到失败"));
    await pending;
    assert.equal(f.notices.length, 1);
    assert.equal(f.inbox.snapshot().items.length, 0);
    assert.equal(f.inbox.snapshot().error, "");
  }
});
