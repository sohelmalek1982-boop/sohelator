/**
 * NY (America/New_York) windows where tape-style vol/range signals are treated as trustworthy.
 * Morning 9:45–11:30, afternoon 1:00–3:45 — excludes open auction noise and last 15m.
 */
function etMinutesSinceMidnight(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(date);
  const h = parseInt(parts.find((p) => p.type === "hour").value, 10);
  const m = parseInt(parts.find((p) => p.type === "minute").value, 10);
  return h * 60 + m;
}

function isTrustedTapeWindowEt(date = new Date()) {
  const mins = etMinutesSinceMidnight(date);
  const morning = mins >= 9 * 60 + 45 && mins <= 11 * 60 + 30;
  const afternoon = mins >= 13 * 60 && mins <= 15 * 60 + 45;
  return morning || afternoon;
}

module.exports = { isTrustedTapeWindowEt, etMinutesSinceMidnight };
