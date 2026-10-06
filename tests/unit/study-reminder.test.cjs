const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const {
  StudyReminder,
  REMINDER_INTERVAL_MINUTES,
} = require("../../electron/services/study-reminder.cjs");
const MINUTE = 60000;
function fixture(t, random = () => 0.5) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leximeet-remind-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const control = {
    now: Date.parse("2026-10-02T00:00:00Z"),
    focused: false,
    notices: 0,
  };
  const state = {
    today: "2026-10-02",
    zone: "Asia/Shanghai",
    profile: {
      planEnabled: true,
      reminderEnabled: true,
      studyStart: "08:00",
      studyEnd: "20:00",
    },
    queue: { tasks: [1, 2] },
  };
  const deps = {
    file: path.join(root, "reminders.json"),
    state: async () => state,
    now: () => control.now,
    focused: () => control.focused,
    random,
    notify: async (count) => {
      assert.equal(count, 2);
      control.notices++;
    },
  };
  return { control, state, deps, reminder: new StudyReminder(deps) };
}

test("随机范围 25–35 分钟，首次进入先等待，平均基准为 30", async (t) => {
  assert.equal(REMINDER_INTERVAL_MINUTES, 30);
  for (const [sample, minutes] of [
    [0, 25],
    [0.5, 30],
    [0.999999, 35],
  ]) {
    const f = fixture(t, () => sample);
    assert.equal(await f.reminder.tick(), false);
    assert.equal(f.reminder.record.nextAt - f.control.now, minutes * MINUTE);
    f.control.now += (minutes - 1) * MINUTE;
    assert.equal(await f.reminder.tick(), false);
    f.control.now += MINUTE;
    assert.equal(await f.reminder.tick(), true);
  }
});

test("下一次随机时刻落盘，重启不重抽签；取消旧每日 3 次上限", async (t) => {
  const f = fixture(t);
  await f.reminder.tick();
  const due = f.reminder.record.nextAt;
  const restarted = new StudyReminder({ ...f.deps, random: () => 0 });
  assert.equal(await restarted.tick(), false);
  assert.equal(restarted.record.nextAt, due);
  for (let i = 0; i < 5; i++) {
    f.control.now = restarted.record.nextAt;
    assert.equal(await restarted.tick(), true);
    assert.equal(restarted.record.nextAt - f.control.now, 25 * MINUTE);
  }
  assert.equal(f.control.notices, 5);
  assert.equal(JSON.parse(fs.readFileSync(f.deps.file)).count, 5);
});

test("时间范围、计划、任务和迁移限制生效；关闭时清除下一次，重新开启仍先等待", async (t) => {
  const f = fixture(t);
  f.control.now -= MINUTE;
  assert.equal(await f.reminder.tick(), false); // 07:59
  assert.equal(fs.existsSync(f.deps.file), false);
  f.control.now += MINUTE;
  await f.reminder.tick();
  f.state.learning = { pending: true };
  assert.equal(await f.reminder.tick(), false);
  assert.equal(f.reminder.record.nextAt, undefined);
  f.state.learning.pending = false;
  await f.reminder.tick();
  f.state.profile.reminderEnabled = false;
  assert.equal(await f.reminder.tick(), false);
  f.state.profile.reminderEnabled = true;
  f.state.profile.planEnabled = false;
  assert.equal(await f.reminder.tick(), false);
  f.state.profile.planEnabled = true;
  f.state.queue.tasks = [];
  assert.equal(await f.reminder.tick(), false);
  f.state.queue.tasks = [1, 2];
  assert.equal(await f.reminder.tick(), false);
  f.control.now = Date.parse("2026-10-02T12:00:00Z");
  assert.equal(await f.reminder.tick(), false); // 20:00 不投递
  assert.equal(f.reminder.record.nextAt, undefined);
  assert.equal(f.control.notices, 0);
});

test("前台与休眠错过的时刻不追补，离开前台后也不会立刻补发", async (t) => {
  const f = fixture(t);
  await f.reminder.tick();
  f.control.now += 120 * MINUTE;
  assert.equal(await f.reminder.tick(), false); // 休眠后晚到超过 2 分钟
  assert.equal(f.reminder.record.nextAt, f.control.now + 30 * MINUTE);
  f.control.now = f.reminder.record.nextAt;
  f.control.focused = true;
  assert.equal(await f.reminder.tick(), false);
  f.control.focused = false;
  assert.equal(await f.reminder.tick(), false);
  f.control.now = f.reminder.record.nextAt;
  assert.equal(await f.reminder.tick(), true);
  assert.equal(f.control.notices, 1);
});

test("跨日、改时间范围与时钟回退重新安排，不沿用不合适的旧时刻", async (t) => {
  const f = fixture(t);
  await f.reminder.tick();
  f.control.now = f.reminder.record.nextAt;
  await f.reminder.tick();
  f.control.now -= 10 * MINUTE;
  assert.equal(await f.reminder.tick(), false);
  assert.equal(f.reminder.record.nextAt, f.control.now + 30 * MINUTE);
  f.state.profile.studyStart = "08:15";
  assert.equal(await f.reminder.tick(), false);
  assert.equal(f.reminder.record.window, "Asia/Shanghai|08:15|20:00");
  f.state.today = "2026-10-03";
  f.control.now = Date.parse("2026-10-03T01:00:00Z");
  assert.equal(await f.reminder.tick(), false);
  assert.equal(f.reminder.record.count, 0);
});

test("旧投递记录不沿用小时节流；投递失败不立即重试", async (t) => {
  const f = fixture(t);
  fs.writeFileSync(
    f.deps.file,
    JSON.stringify({ day: f.state.today, count: 3, lastAt: f.control.now }),
  );
  const reminder = new StudyReminder({
    ...f.deps,
    notify: async () => {
      throw new Error("OS 不可用");
    },
  });
  assert.equal(await reminder.tick(), false);
  assert.equal(reminder.record.nextAt, f.control.now + 30 * MINUTE);
  f.control.now = reminder.record.nextAt;
  await assert.rejects(reminder.tick(), /OS 不可用/);
  assert.equal(await reminder.tick(), false);
  assert.equal(reminder.record.nextAt, f.control.now + 30 * MINUTE);
});

test("退出期间迟到的队列查询不会抽签或投递", async (t) => {
  const f = fixture(t);
  let resolve;
  const reminder = new StudyReminder({
    ...f.deps,
    state: () =>
      new Promise((done) => {
        resolve = done;
      }),
  });
  const pending = reminder.tick();
  reminder.close();
  resolve(f.state);
  assert.equal(await pending, false);
  assert.equal(fs.existsSync(f.deps.file), false);
});
