"use strict";
const { NOTIFICATION_ICON } = require("./notification-icon.cjs");

const LABELS = {
  "word-list": "回想单词",
  "meaning-choice": "看词选义",
  copy: "单词临摹",
  recall: "单词默写",
  listening: "听音辨词",
  cloze: "语境填空",
};

// 系统通知适配器。只收集用户意图；固定题目、判题和幂等由 Core 负责。
class StudyNotifications {
  constructor({
    Notification,
    request,
    play,
    open,
    changed,
    platform = process.platform,
    now = Date.now,
  }) {
    Object.assign(this, {
      Notification,
      request,
      play,
      open,
      changed,
      platform,
      now,
    });
    this.notices = new Map();
    this.generation = 0;
    this.status = { state: "ready", message: "" };
  }
  supportedModes() {
    if (!this.Notification.isSupported() || !["darwin", "win32"].includes(this.platform)) return [];
    return Object.keys(LABELS).filter((mode) => mode !== "listening" || Boolean(this.play));
  }
  async issue() {
    const generation = this.generation;
    const question = await this.request({
      action: "issueReminderQuestion",
      supportedModes: this.supportedModes(),
    });
    if (generation !== this.generation) return false;
    if (question.unavailable) {
      this.status = { state: "unavailable", message: question.unavailable };
      this.changed?.();
      return false;
    }
    this.show(question);
    return true;
  }
  options(q, listeningReady = false) {
    const result = {
      icon: NOTIFICATION_ICON,
      id: `study-${q.id}`,
      groupId: "leximeet-study",
      title: `词遇 · ${LABELS[q.mode]}`,
      silent: true,
    };
    if (q.mode === "meaning-choice") {
      result.body = q.word;
      result.actions = q.options.map((option) => ({
        type: "button",
        text: option.text,
      }));
    } else if (q.mode === "word-list") {
      result.body = q.word;
      result.actions = ["熟练 +1", "不熟悉 −1", "查看释义 −1"].map((text) => ({
        type: "button",
        text,
      }));
    } else if (q.mode === "listening" && !listeningReady) {
      result.body = "播放发音后，回复你听到的单词。";
      result.actions = [{ type: "button", text: "播放发音" }];
    } else {
      result.body =
        q.mode === "copy"
          ? q.word
          : q.mode === "cloze"
            ? q.context
            : q.mode === "listening"
              ? "请输入刚才听到的单词"
              : q.meaning.replace(
                  new RegExp(q.word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
                  "_____",
                );
      result.hasReply = true;
      result.replyPlaceholder = "输入单词";
    }
    return result;
  }
  show(q, listeningReady = false, existing = null) {
    const notice = existing || new this.Notification(this.options(q, listeningReady));
    const item = { notice, question: q, busy: false, timer: null };
    this.notices.set(q.id, item);
    const guard =
      (run) =>
      async (...args) => {
        if (item.busy || this.notices.get(q.id) !== item) return;
        item.busy = true;
        try {
          await run(...args);
        } catch (error) {
          this.status = { state: "failed", message: error.message };
          this.changed?.();
        } finally {
          item.busy = false;
        }
      };
    notice.on("failed", () => {
      this.status = {
        state: "failed",
        message: "系统通知未能投递。请检查通知权限，并使用已签名的词遇应用。",
      };
      this.changed?.();
    });
    notice.on("show", () => {
      this.status = { state: "submitted", message: "已提交给系统通知中心" };
    });
    notice.on("click", () => this.open?.()); // 只有用户主动点击才打开主窗口。
    notice.on(
      "action",
      guard(async (details, legacyIndex) => {
        const index = details?.actionIndex ?? legacyIndex;
        if (q.mode === "listening" && !listeningReady) {
          if (index !== 0) return;
          await this.play(q.word);
          // 过期、停用或退出后的音频回执不能重新创建通知。
          if (this.notices.get(q.id) !== item) return;
          this.remove(q.id);
          this.show(q, true);
          return;
        }
        if (q.mode === "meaning-choice" && q.options[index])
          await this.answer(q, { choiceId: q.options[index].id });
        else if (q.mode === "word-list" && [0, 1, 2].includes(index))
          await this.answer(q, {
            signal: ["familiar", "unfamiliar", "reveal"][index],
          });
      }),
    );
    notice.on(
      "reply",
      guard(async (details, legacyReply) => {
        if (!["copy", "recall", "cloze", "listening"].includes(q.mode)) return;
        if (q.mode === "listening" && !listeningReady) return;
        const answer = details?.reply ?? legacyReply;
        if (typeof answer !== "string" || !answer.trim()) return;
        await this.answer(q, { answer });
      }),
    );
    // 过期只是移除入口，绝不自动答错或复用剪贴板的超时采集。
    item.timer = setTimeout(
      () => this.remove(q.id),
      Math.max(1, Date.parse(q.expiresAt) - this.now()),
    );
    item.timer.unref?.();
    if (!existing) notice.show();
    return notice;
  }
  async answer(q, payload) {
    const generation = this.generation;
    const result = await this.request({
      action: "answerReminderQuestion",
      questionId: q.id,
      ...payload,
    });
    this.changed?.();
    if (generation !== this.generation) return;
    this.remove(q.id);
    this.status = {
      state: "answered",
      message: result.duplicate
        ? "本题已记录"
        : `${result.correct ? "已记录" : "继续巩固"} · ${result.familiarity.score} / 30`,
    };
    this.changed?.();
    const feedback = new this.Notification({
      icon: NOTIFICATION_ICON,
      id: `study-result-${q.id}`,
      groupId: "leximeet-study-results",
      title: this.status.message,
      body: payload.signal === "reveal" ? q.meaning : q.word,
      silent: true,
    });
    feedback.on("failed", () => {});
    feedback.show();
  }
  async restore(questions) {
    if (!this.Notification.getHistory) return;
    const generation = this.generation;
    const delivered = await this.Notification.getHistory();
    if (generation !== this.generation) return;
    const pending = new Map(questions.map((q) => [`study-${q.id}`, q]));
    for (const notice of delivered) {
      const q = pending.get(notice.id);
      if (q) this.show(q, Boolean(notice.hasReply), notice);
      else if (notice.id?.startsWith("study-")) this.Notification.remove?.(notice.id);
    }
  }
  remove(id) {
    const item = this.notices.get(id);
    clearTimeout(item?.timer);
    item?.notice.removeAllListeners();
    item?.notice.close();
    this.Notification.remove?.(`study-${id}`);
    this.notices.delete(id);
  }
  close() {
    this.generation++;
    for (const id of this.notices.keys()) this.remove(id);
  }
}
module.exports = { StudyNotifications, LABELS };
