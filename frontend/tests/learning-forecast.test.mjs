import test from "node:test";
import assert from "node:assert/strict";
import { forecastCurve, forecastDayLabel } from "../src/desktop/learning-forecast.js";
const data = {
  total: 95,
  learned: 5,
  remaining: 90,
  days: 10,
  dailyNew: 10,
  firstDays: [{ count: 5 }],
};
test("初学曲线用今日剩余额度而非再次领取整日额度，最后一天不超过目标", () => {
  const points = forecastCurve(data, "all");
  assert.deepEqual(
    points.slice(0, 3).map((x) => x.count),
    [5, 10, 20],
  );
  assert.equal(points.at(-1).count, 95);
  assert.ok(points.every((x, i) => !i || x.count >= points[i - 1].count));
});
test("今日无剩余额度也保留当前值，明天再按额度增长", () => {
  assert.deepEqual(
    forecastCurve({ ...data, firstDays: [{ count: 0 }] }, 2).map((x) => x.count),
    [5, 5, 15],
  );
});
test("多年目标最多121点，含整个计划端点；短区间不改变原始预览", () => {
  const original = JSON.stringify(data);
  assert.equal(forecastCurve(data, 7).at(-1).offset, 7);
  assert.equal(JSON.stringify(data), original);
  const long = forecastCurve({ ...data, days: 85001, remaining: 850000, total: 850005 }, "all");
  assert.ok(long.length <= 121);
  assert.equal(long.at(-1).offset, 85001);
  assert.equal(long.at(-1).count, 850005);
});
test("空目标和已完成目标不捏造未来增长", () => {
  assert.deepEqual(forecastCurve(null), []);
  assert.deepEqual(forecastCurve({ ...data, remaining: 0, days: 0 }, "all"), [
    { offset: 0, count: 5 },
  ]);
});
test("今日完成的终点标今天，跨年与闰日按业务日期推进而非浏览器时区", () => {
  const today = { firstDays: [{ day: "2026-12-31" }] };
  assert.equal(forecastDayLabel(today, 0), "当前");
  assert.equal(forecastDayLabel(today, 1), "2026-12-31");
  assert.equal(forecastDayLabel(today, 2), "2027-01-01");
  assert.equal(forecastDayLabel({ firstDays: [{ day: "2028-02-28" }] }, 2), "2028-02-29");
  assert.equal(forecastDayLabel(null, 1), "预计完成");
});
