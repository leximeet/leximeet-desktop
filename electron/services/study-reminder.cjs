"use strict";
const fs = require("node:fs");
const path = require("node:path");
const REMINDER_INTERVAL_MINUTES = 30;
const REMINDER_JITTER_MINUTES = 5;
const MINUTE = 60000;
const MAX_LATENESS = 2 * MINUTE;

// 设备级随机提醒。只读队列；下一次时刻持久化，重启不重复抽签，错过的提醒不追补。
class StudyReminder {
  constructor({ file, state, focused, notify, now = Date.now, random = Math.random }) {
    Object.assign(this, { file, state, focused, notify, now, random });
    this.record = {};
    this.running = false;
    this.generation = 0;
    try {
      this.record = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {}
  }
  persist(record) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(record), {
      mode: 0o600,
    });
    fs.renameSync(`${this.file}.tmp`, this.file);
    this.record = record;
  }
  schedule(now, day, window) {
    // 在 25–35 分钟中均匀取整，平均 30；测试可注入随机源，不依赖真实等待。
    const sample = Math.max(0, Math.min(0.999999, this.random()));
    const minutes =
      REMINDER_INTERVAL_MINUTES -
      REMINDER_JITTER_MINUTES +
      Math.floor(sample * (2 * REMINDER_JITTER_MINUTES + 1));
    return {
      version: 2,
      day,
      window,
      count: this.record.day === day ? this.record.count || 0 : 0,
      lastAt: this.record.lastAt <= now ? this.record.lastAt || null : null,
      nextAt: now + minutes * MINUTE,
    };
  }
  clearPending() {
    if (this.record.nextAt != null) {
      const next = { ...this.record };
      delete next.nextAt;
      this.persist(next);
    }
  }
  async tick() {
    if (this.running) return false;
    this.running = true;
    const generation = this.generation;
    try {
      const state = await this.state(),
        plan = state.profile,
        now = this.now();
      if (generation !== this.generation) return false;
      if (
        state.learning?.pending ||
        !plan.planEnabled ||
        !plan.reminderEnabled ||
        !state.queue.tasks.length
      ) {
        this.clearPending();
        return false;
      }
      const time = new Intl.DateTimeFormat("en-GB", {
        timeZone: state.zone,
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(new Date(now));
      if (time < plan.studyStart || time >= plan.studyEnd) {
        this.clearPending();
        return false;
      }
      const window = [state.zone, plan.studyStart, plan.studyEnd].join("|");
      if (
        this.record.version !== 2 ||
        this.record.day !== state.today ||
        this.record.window !== window ||
        !Number.isFinite(this.record.nextAt) ||
        now < this.record.lastAt ||
        this.record.nextAt - now >
          (REMINDER_INTERVAL_MINUTES + REMINDER_JITTER_MINUTES + 1) * MINUTE
      ) {
        this.persist(this.schedule(now, state.today, window));
        return false;
      }
      if (now < this.record.nextAt) return false;
      if (this.focused() || now - this.record.nextAt > MAX_LATENESS) {
        // 前台操作、休眠或长时间关闭错过的时刻，只重新安排一次，不补发积压。
        this.persist(this.schedule(now, state.today, window));
        return false;
      }
      const next = this.schedule(now, state.today, window);
      next.count++;
      next.lastAt = now;
      // 先保存投递意图；失败也不会立刻重试，不把系统提交当成用户已看到。
      this.persist(next);
      await this.notify(state.queue.tasks.length);
      return true;
    } finally {
      this.running = false;
    }
  }
  start() {
    this.close();
    this.timer = setInterval(() => this.tick().catch(() => {}), MINUTE);
    this.timer.unref?.();
  }
  close() {
    this.generation++;
    clearInterval(this.timer);
  }
}
module.exports = {
  StudyReminder,
  REMINDER_INTERVAL_MINUTES,
  REMINDER_JITTER_MINUTES,
};
