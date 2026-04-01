/**
 * SOHELATOR blueprint — cheap 5-min monitor + wake-up (Prompt 7)
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12)
 *
 * Schedule: netlify.toml — cron every five minutes — this function gates:
 *   • Weekday RTH 8:00–16:00 ET: every run → cheap scan + wild wakeup (score ≥85, vol ≥3×, text catalyst)
 *   • Weekday after-hours 16:01–20:00 ET: at most once per ET clock hour → cheap scan with Tradier news,
 *     symbols in our universe mentioned in headlines get priority; body forwards catalyst text for Grok.
 *
 * Netlify: URL / DEPLOY_PRIME_URL, TRADIER_TOKEN (news + scan), GROK via expensive /api/scan,
 * NETLIFY_SITE_ID + NETLIFY_TOKEN (debounce blob), VAPID_* (push via lib/pushAll).
 */

const fetch = globalThis.fetch || require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { sendPushToAll } = require("./lib/pushAll.js");

/** Must match DEFAULT_UNIVERSE in netlify/functions/scan.js for headline intersection. */
const SCAN_UNIVERSE = new Set([
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "META",
  "AMD",
  "GOOGL",
  "AMZN",
  "NFLX",
  "COIN",
  "MSTR",
]);

function baseUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(
    /\/$/,
    ""
  );
}

function tradierBaseUrl() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
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

/** ET calendar date YYYY-MM-DD */
function ymdEt(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** 8:00am–4:00pm ET weekdays (Prompt 8 RTH window) */
function isRthEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= 8 * 60 && t <= 16 * 60;
}

/**
 * Prompt 12 — after-hours cheap scan window: 16:01–20:00 ET (hourly, deduped per clock hour).
 */
function isAfterHoursCheapWindowEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t > 16 * 60 && t <= 20 * 60;
}

function normList(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function volRatioOf(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function hasCatalyst(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST PLAY/i.test(
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

/**
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12)
 * Tradier GET /v1/markets/news (limit). Shape varies; we normalize article/item arrays.
 */
async function fetchTradierMarketNews(limit = 40) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) return { items: [], err: "no_token" };
  const url = `${tradierBaseUrl()}/v1/markets/news?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    return { items: [], err: `http_${res.status}`, detail: t.slice(0, 200) };
  }
  const j = await res.json();
  const items = normList(
    j.news?.article || j.news?.item || j.article || j.articles || j.items
  );
  return { items, raw: j };
}

/**
 * Prompt 12 — symbols in SCAN_UNIVERSE mentioned in news headlines / symbol fields.
 */
function universeSymsFromNews(items) {
  const found = new Set();
  const headlines = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const h = String(it.headline || it.title || it.description || "");
    if (h) headlines.push(h);
    const symFields = normList(
      it.symbols?.symbol || it.symbols || it.symbol || it.tickers
    );
    for (let j = 0; j < symFields.length; j++) {
      const s = String(symFields[j] || "")
        .trim()
        .toUpperCase();
      if (s && SCAN_UNIVERSE.has(s)) found.add(s);
    }
    const m = h.match(/\b([A-Z]{1,5})\b/g);
    if (m) {
      for (let k = 0; k < m.length; k++) {
        const tok = m[k];
        if (tok.length >= 2 && SCAN_UNIVERSE.has(tok)) found.add(tok);
      }
    }
  }
  const summary = headlines.slice(0, 14).join(" | ").slice(0, 1500);
  return { syms: Array.from(found), catalystNewsSummary: summary };
}

exports.handler = async () => {
  const headers = { "Content-Type": "application/json" };
  const out = {
    ok: true,
    at: new Date().toISOString(),
    fn: "cheap-monitor",
  };

  const base = baseUrl();
  if (!base) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ...out, error: "URL / DEPLOY_PRIME_URL not set" }),
    };
  }

  const now = new Date();
  const inRth = isRthEt(now);
  const inAfterHours = isAfterHoursCheapWindowEt(now);

  if (!inRth && !inAfterHours) {
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

  let scanBody = { mode: "cheap" };
  let afterHoursSlot = null;

  if (inAfterHours) {
    const tmin = minutesEt(now);
    const hourEt = Math.floor(tmin / 60);
    afterHoursSlot = `${ymdEt(now)}-${hourEt}`;

    /* Without blobs, only attempt once per ET hour (first five-minute bucket 00–04). */
    if (
      !(process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) &&
      tmin % 60 > 4
    ) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...out,
          status: "ok",
          skipped: "after_hours_set_NETLIFY_SITE_ID_TOKEN_for_hourly_dedupe",
          afterHoursSlot,
        }),
      };
    }

    if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) {
      try {
        const store = getStore({
          name: "sohelator-cheap-monitor",
          siteID: process.env.NETLIFY_SITE_ID,
          token: process.env.NETLIFY_TOKEN,
        });
        const prevAh = await store.get("afterhours_last_slot", { type: "json" });
        if (prevAh && String(prevAh.slotKey) === afterHoursSlot) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              ...out,
              status: "ok",
              skipped: "after_hours_hour_already_scanned",
              afterHoursSlot,
            }),
          };
        }
        await store.setJSON("afterhours_last_slot", {
          slotKey: afterHoursSlot,
          at: Date.now(),
        });
      } catch (e) {
        console.warn("cheap-monitor afterhours dedupe", e?.message || e);
      }
    }

    try {
      const { items, err } = await fetchTradierMarketNews(45);
      out.newsFetch = err || "ok";
      const { syms, catalystNewsSummary } = universeSymsFromNews(items);
      out.newsUniverseHits = syms;
      scanBody = {
        mode: "cheap",
        extraSymbols: syms,
        prioritySymbols: syms,
        catalystNewsSummary:
          catalystNewsSummary ||
          (syms.length
            ? "Headlines flagged symbols: " + syms.join(", ")
            : ""),
      };
    } catch (e) {
      console.warn("cheap-monitor news", e?.message || e);
      scanBody = { mode: "cheap" };
    }
    out.path = "after_hours_hourly";
    out.afterHoursSlot = afterHoursSlot;
  } else {
    out.path = "rth_5min";
  }

  try {
    const res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scanBody),
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
      const expBody = {
        mode: "expensive",
        extraSymbols: scanBody.extraSymbols || [],
        prioritySymbols: scanBody.prioritySymbols || [],
        catalystNewsSummary: scanBody.catalystNewsSummary || "",
        /* Prompt 12 — allow Grok after 4pm ET when wake-up runs on catalyst / wild scores */
        allowCatalystGrokOutsideWindow: true,
      };
      const exp = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expBody),
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
