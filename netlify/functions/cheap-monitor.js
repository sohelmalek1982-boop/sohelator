/**
 * SOHELATOR blueprint — cheap 5-min monitor + wake-up (Prompt 7)
 * Schedule: netlify.toml cheap-monitor — cron every five minutes (see netlify.toml)
 * Prompt 8 — ET 8:00–16:00 window; status outside_window when skipped. GROK via expensive /api/scan when wild.
 *
 * Netlify: URL / DEPLOY_PRIME_URL, TRADIER_TOKEN (via scan), GROK_API_KEY (via expensive scan),
 * NETLIFY_SITE_ID + NETLIFY_TOKEN (debounce blob), VAPID_* (push via lib/pushAll).
 */

const fetch = globalThis.fetch || require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { sendPushToAll } = require("./lib/pushAll.js");

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

/** Minutes since midnight America/New_York */
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

/** 8:00am–4:00pm ET weekdays (Prompt 8 reliability window) */
function isRthEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= 8 * 60 && t <= 16 * 60;
}

function volRatioOf(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function hasCatalyst(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE/i.test(
    s
  );
}

function isWild(a) {
  return (
    Number(a?.score || 0) >= 85 ||
    volRatioOf(a) >= 3 ||
    hasCatalyst(a)
  );
}

exports.handler = async () => {
  const headers = { "Content-Type": "application/json" };
  const out = { ok: true, at: new Date().toISOString(), fn: "cheap-monitor" };

  const base = baseUrl();
  if (!base) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ...out, error: "URL / DEPLOY_PRIME_URL not set" }),
    };
  }

  const now = new Date();
  if (!isRthEt(now)) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...out,
        status: "outside_window",
        skipped: "outside_et_window",
      }),
    };
  }

  try {
    const res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cheap" }),
    });
    const j = await res.json().catch(() => ({}));
    out.cheapHttp = res.status;
    out.cheapSuccess = !!(j && j.success);
    const alerts = Array.isArray(j.alerts) ? j.alerts : [];
    out.alertCount = alerts.length;

    const wild = alerts.filter(isWild);
    out.wildCount = wild.length;

    if (!wild.length) {
      out.status = "ok";
      return { statusCode: 200, headers, body: JSON.stringify(out) };
    }

    let doExpensive = true;
    if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) {
      try {
        const store = getStore({
          name: "sohelator-cheap-monitor",
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_TOKEN,
        });
        const fp = wild
          .map((a) => `${a.symbol}:${a.score}:${volRatioOf(a)}`)
          .sort()
          .join("|");
        const prev = await store.get("exp_debounce", { type: "json" });
        const t = Date.now();
        if (
          prev &&
          prev.fp === fp &&
          t - Number(prev.at || 0) < 25 * 60 * 1000
        ) {
          doExpensive = false;
          out.expensiveSkipped = "debounced_25m";
        } else {
          await store.setJSON("exp_debounce", { fp, at: t });
        }
      } catch (e) {
        console.warn("cheap-monitor debounce", e?.message || e);
      }
    }

    if (doExpensive) {
      const exp = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "expensive" }),
      });
      out.expensiveHttp = exp.status;
      const ej = await exp.json().catch(() => ({}));
      out.expensiveOk = !!(ej && ej.success);
    }

    const push = await sendPushToAll({
      title: "SOHELATOR — Wild / high-conviction scan",
      body:
        wild
          .slice(0, 4)
          .map((w) => `${w.symbol} ${w.score}`)
          .join(" · ") || "Check dashboard",
      data: { kind: "cheap-monitor-wild", count: wild.length },
    });
    out.push = push;
    out.status = "ok";

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    console.error("cheap-monitor", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        fn: "cheap-monitor",
      }),
    };
  }
};
