// 只读额度推演：不制造练习事件，不预测熟悉度、遗忘或未来 FSRS 到期。
export function forecastCurve(forecast, horizon = 30) {
  if (!forecast) return [];
  const span = Math.min(
    forecast.days,
    horizon === "all" ? forecast.days : Math.max(0, Number(horizon) || 0),
  );
  const samples = Math.min(span, 120);
  const offsets = [
    ...new Set(
      Array.from({ length: samples + 1 }, (_, i) => Math.round((i * span) / Math.max(1, samples))),
    ),
  ];
  const first = forecast.firstDays?.[0]?.count || 0;
  const daily = forecast.dailyNew || 10;
  return offsets.map((offset) => ({
    offset,
    count:
      forecast.learned + Math.min(forecast.remaining, offset ? first + (offset - 1) * daily : 0),
  }));
}

// 第一个增量是今天结束时的额度；按业务日期标注，不能把今天误写成一天后。
export function forecastDayLabel(forecast, offset) {
  if (!offset) return "当前";
  const today = forecast?.firstDays?.[0]?.day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today || "")) return "预计完成";
  const [year, month, day] = today.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset - 1));
  return date.toISOString().slice(0, 10);
}
