/**
 * NYSE full-day closures (observed). Extend yearly.
 * Source pattern: exchange holiday calendar — verify each year.
 */
const NYSE_HOLIDAYS = new Set([
  "2025-01-01",
  "2025-01-20",
  "2025-02-17",
  "2025-04-18",
  "2025-05-26",
  "2025-06-19",
  "2025-07-04",
  "2025-09-01",
  "2025-11-27",
  "2025-12-25",
  "2026-01-01",
  "2026-01-19",
  "2026-02-16",
  "2026-04-03",
  "2026-05-25",
  "2026-06-19",
  "2026-07-03",
  "2026-09-07",
  "2026-11-26",
  "2026-12-25",
]);

function ymdNy(d = new Date()) {
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function isNyseHoliday(d = new Date()) {
  return NYSE_HOLIDAYS.has(ymdNy(d));
}

function isNyseWeekend(d = new Date()) {
  const wd = d.toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  });
  return wd === "Sat" || wd === "Sun";
}

function isEquitySessionDay(d = new Date()) {
  return !isNyseWeekend(d) && !isNyseHoliday(d);
}

/** Regular cash session 9:30–16:00 ET (not extended hours). */
function isNyRegularSessionNow(d = new Date()) {
  if (!isEquitySessionDay(d)) return false;
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  const h = +p.find((x) => x.type === "hour").value;
  const m = +p.find((x) => x.type === "minute").value;
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

module.exports = {
  ymdNy,
  isNyseHoliday,
  isNyseWeekend,
  isEquitySessionDay,
  isNyRegularSessionNow,
};
