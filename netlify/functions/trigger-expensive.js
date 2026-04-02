/**
 * SOHELATOR blueprint — scheduled expensive /api/scan (Prompt 7)
 * Schedule: netlify.toml — e.g. every 15m UTC; handler fires when ET time is within ±2 min of a slot.
 * Slot centers (America/New_York): 8:15, 9:25, 9:35, 9:45, 11:00, 12:00, 13:00, 14:00, 15:00, 16:00
 */

const fetch = globalThis.fetch || require("node-fetch");

function baseUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(
    /\/$/,
    ""
  );
}

function weekdayShortEt(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
}

function isWeekdayEt(d) {
  const w = weekdayShortEt(d);
  return w !== "Sat" && w !== "Sun";
}

function minutesEt(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}

/** ET minutes since midnight (window centers); aligned with scheduled cron times */
const EXPENSIVE_SLOTS_ET = [495, 565, 575, 585, 660, 720, 780, 840, 900, 960];

function isExpensiveMinuteEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return EXPENSIVE_SLOTS_ET.some((slot) => Math.abs(t - slot) <= 2);
}

exports.handler = async () => {
  const headers = { "Content-Type": "application/json" };
  const base = baseUrl();
  if (!base) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "URL / DEPLOY_PRIME_URL not set",
        fn: "trigger-expensive",
      }),
    };
  }

  const now = new Date();
  if (!isExpensiveMinuteEt(now)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        skipped: true,
        reason: "not_et_expensive_slot",
        etMinute: minutesEt(now),
        fn: "trigger-expensive",
      }),
    };
  }

  try {
    const res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "expensive" }),
    });
    const j = await res.json().catch(() => ({}));
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        triggered: true,
        http: res.status,
        scanSuccess: !!(j && j.success),
        alertCount: Array.isArray(j.alerts) ? j.alerts.length : 0,
        mode: j.mode,
        slotEtMin: minutesEt(now),
        fn: "trigger-expensive",
      }),
    };
  } catch (e) {
    console.error("trigger-expensive", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        fn: "trigger-expensive",
      }),
    };
  }
};
