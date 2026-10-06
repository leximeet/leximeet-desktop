"use strict";
const http = require("node:http");
const { test, expect } = require("../helpers/electron-fixture.cjs");
const { personalFacts, attachJson } = require("../helpers/journey-evidence.cjs");

// 真实可解码 PCM 音频；保持 1.5 秒播放周期，不能以伪造 ended 验证自动切题。
function wav(seconds = 1.5) {
  const frames = Math.round(16000 * seconds);
  const buffer = Buffer.alloc(44 + frames * 2);
  buffer.write("RIFF");
  buffer.writeUInt32LE(buffer.length - 8, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(frames * 2, 40);
  return buffer;
}

for (const broken of [false, true]) {
  test(`真实听音反馈：${broken ? "播放失败仍可继续" : "一秒后等待 1.5 秒音频自然结束"}，只保存一次`, async ({
    desktopFactory,
  }, testInfo) => {
    const requests = [];
    const server = http.createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(200, { "Content-Type": "audio/wav" });
      // MIME/魔数通过真实提供者的输入检查，但内容不能被原生播放器解码。
      response.end(broken ? Buffer.from("RIFF-this-is-not-a-valid-wave-file") : wav());
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const desktop = await desktopFactory.start();
      const page = desktop.page;
      await page.getByRole("button", { name: "跳过教学", exact: true }).click();
      await page.evaluate(async (url) => {
        await window.leximeet.audioSettings({
          action: "save",
          provider: "custom",
          custom: { url, method: "GET", body: "" },
        });
        for (const word of ["way", "time"])
          await window.leximeet.desktopCommand({
            action: "capture",
            word,
            context: `This ${word} matters.`,
          });
      }, `http://127.0.0.1:${server.address().port}/audio?word={word}`);
      await page.reload();
      await expect(page.locator('[data-guide="nav-practice"]')).toBeVisible();
      await page.evaluate(() => {
        const NativeAudio = window.Audio;
        window.__practiceAudio = { events: [], confirmedAt: null, nextAt: null };
        let cue = 0;
        // 只观察原生播放器；不替换解码、play/pause、时长或 ended/error 事件。
        window.Audio = new Proxy(NativeAudio, {
          construct(target, args) {
            const audio = Reflect.construct(target, args);
            const current = ++cue;
            for (const type of ["playing", "ended", "pause", "error"])
              audio.addEventListener(type, () => {
                window.__practiceAudio.events.push({
                  cue: current,
                  type,
                  at: performance.now(),
                  duration: audio.duration,
                  currentTime: audio.currentTime,
                });
              });
            return audio;
          },
        });
        const observer = new MutationObserver(() => {
          const stage = document.querySelector(".practice-stage");
          const evidence = window.__practiceAudio;
          if (stage?.classList.contains("correct") && evidence.confirmedAt === null)
            evidence.confirmedAt = performance.now();
          if (stage?.querySelector(".eyebrow")?.textContent.trim().startsWith("2 /")) {
            evidence.nextAt = performance.now();
            observer.disconnect();
          }
        });
        observer.observe(document.body, {
          subtree: true,
          attributes: true,
          childList: true,
          characterData: true,
        });
      });
      await page.locator('[data-guide="nav-practice"]').click();
      await page.getByRole("tab", { name: "听音辨词", exact: true }).click();
      await expect(page.locator(".practice-stage .eyebrow")).toContainText("1 / 2");
      await expect
        .poll(() =>
          page.evaluate(
            (broken) =>
              window.__practiceAudio.events.some(
                (event) => event.cue === 1 && event.type === (broken ? "error" : "playing"),
              ),
            broken,
          ),
        )
        .toBe(true);
      await page.locator(".spelling-editor input").fill("way");
      await page.locator(".spelling-editor input").press("Enter");
      await expect(page.locator(".practice-feedback")).toContainText("正确 · 已记录");
      await expect.poll(() => page.evaluate(() => window.__practiceAudio.nextAt)).not.toBeNull();
      const evidence = await page.evaluate(() => window.__practiceAudio);
      expect(evidence.nextAt - evidence.confirmedAt).toBeGreaterThanOrEqual(950);
      if (!broken) {
        const start = evidence.events.find((event) => event.cue === 1 && event.type === "playing");
        const end = evidence.events.find((event) => event.cue === 1 && event.type === "ended");
        expect(end, "当前题必须自然播放完，不能切题时 pause 截断").toBeTruthy();
        expect(end.duration).toBeCloseTo(1.5, 1);
        expect(end.at - start.at).toBeGreaterThanOrEqual(1400);
        expect(
          end.at - evidence.confirmedAt,
          "确认后一秒时仍在播放，确实覆盖音频等待门禁",
        ).toBeGreaterThan(1000);
        expect(evidence.nextAt).toBeGreaterThanOrEqual(end.at);
        expect(
          evidence.events.some(
            (event) =>
              event.cue === 1 &&
              event.type === "pause" &&
              event.at < end.at &&
              event.currentTime < end.duration - 0.05,
          ),
        ).toBe(false);
      } else {
        expect(evidence.nextAt - evidence.confirmedAt).toBeLessThan(2500);
      }
      expect(requests.some((url) => /word=way/.test(url))).toBe(true);
      const personal = personalFacts(desktop.profileDir);
      const facts = personal.practice;
      expect(facts).toHaveLength(1);
      // SQL 外键使用稳定 UUID；不能把词面字符串误当公开词条 ID。
      expect(personal.words.find((word) => word.id === facts[0].word_id)?.word).toBe("way");
      expect(facts[0].correct).toBe(1);
      await attachJson(testInfo, "actual-audio-continuity", { evidence, requests, facts });
      expect(desktop.pageErrors).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      server.closeAllConnections();
    }
  });
}
