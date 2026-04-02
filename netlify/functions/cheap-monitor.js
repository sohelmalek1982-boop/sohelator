/**
 * SOHELATOR blueprint — cheap 5-min monitor + wake-up (Prompt 7)
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12)
 * SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19):
 *   POST /api/scan with suppressTelegram:true; this function relays every alert score≥65 (deduped) using the same body format as scan.js.
 *
 * Schedule: netlify.toml — cron every five minutes — this function gates:
 *   • Weekday RTH 8:00–16:00 ET: every run → cheap scan + wild wakeup (score ≥72, vol ≥2.5×, text catalyst)
 *   • Weekday after-hours 16:01–20:00 ET: at most once per ET clock hour → cheap scan with Tradier news,
 *     symbols in our universe mentioned in headlines get priority; body forwards catalyst text for Grok.
 *
 * Netlify: URL / DEPLOY_PRIME_URL, TRADIER_TOKEN (news + scan), GROK via expensive /api/scan,
 * NETLIFY_SITE_ID + NETLIFY_TOKEN (debounce blob + alert-cooldowns), VAPID_* (push via lib/pushAll).
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
    Number(a?.score || 0) >= 72 ||
    volRatioOf(a) >= 2.5 ||
    hasCatalyst(a)
  );
}

/* ─── Prompt 19 — mirror scan.js Telegram formatting (keep in sync with netlify/functions/scan.js) ─── */
const TELEGRAM_ALERT_MIN_SCORE = 65;

const ALERT_COOLDOWNS_BLOB_KEY = "alert-cooldowns";
const ALERT_TELEGRAM_COOLDOWN_MS = 20 * 60 * 1000;
const ALERT_TELEGRAM_SCORE_JUMP = 5;

function cheapMonitorBlobStore() {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) return null;
  return getStore({
    name: "sohelator-cheap-monitor",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

/** @returns {Promise<Record<string, { score: number, firedAt: number }>>} */
async function getAlertCooldowns() {
  const store = cheapMonitorBlobStore();
  if (!store) return {};
  try {
    const data = await store.get(ALERT_COOLDOWNS_BLOB_KEY, { type: "json" });
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return {};
  } catch (e) {
    console.warn("cheap-monitor getAlertCooldowns", e?.message || e);
    return {};
  }
}

async function setAlertCooldown(symbol, score) {
  const store = cheapMonitorBlobStore();
  if (!store) return;
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return;
  const s = Math.round(Number(score) || 0);
  try {
    let prev = await store.get(ALERT_COOLDOWNS_BLOB_KEY, { type: "json" });
    if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
    const next = {
      ...prev,
      [sym]: { score: s, firedAt: Date.now() },
    };
    await store.setJSON(ALERT_COOLDOWNS_BLOB_KEY, next);
  } catch (e) {
    console.warn("cheap-monitor setAlertCooldown", e?.message || e);
  }
}

function volRatioOfAlertP19(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function hasCatalystSignalP19(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST/i.test(
    s
  );
}

function hasRegimeOrLevelKeywordsP19(a) {
  const v = (
    String(a?.aiVerdict || "") +
    " " +
    String(a?.aiCoPilot || "")
  ).toUpperCase();
  return /REVERSAL|REGIME|PIVOT|KEY LEVEL|BREAKDOWN|BREAKOUT|SWEEP|STOP\s*RUN|VWAP/.test(v);
}

function historicalMatchesShortP19(a) {
  const sim = Array.isArray(a?.similar) ? a.similar : [];
  if (sim.length) {
    const wins = sim.filter((s) => s.win).length;
    const wr = Math.round((wins / sim.length) * 100);
    return `${sim.length} matches • ~${wr}% wins`;
  }
  const h = String(a.historicalSummary || "");
  const m = h.match(/Historical:\s*([^.\n]+)/i);
  if (m) return m[1].trim().slice(0, 120);
  return "—";
}

function buildTelegramPrompt19Message(a) {
  const sym = String(a.symbol || "—").toUpperCase();
  const play = String(a.playTypeLabel || a.playType || "SETUP");
  const score = Math.round(Number(a.score) || 0);
  const edge = Number(a.edge ?? a.ev ?? 0);
  const edgeStr = Number.isFinite(edge) ? edge.toFixed(2) : "—";
  const last = Number(a.last ?? a.underlyingAtAlert);
  const priceStr = Number.isFinite(last) ? `$${last.toFixed(2)}` : "—";
  const bp = a.barChgPct;
  let chg = "";
  if (bp != null && Number.isFinite(Number(bp))) {
    const p = Number(bp);
    chg = ` (${p >= 0 ? "+" : ""}${p.toFixed(1)}%)`;
  }
  const ent = Number(a.entry);
  const st = Number(a.stop);
  const tg = Number(a.target);
  const entryStr = Number.isFinite(ent) ? ent.toFixed(2) : "—";
  const stopStr = Number.isFinite(st) ? st.toFixed(2) : "—";
  const tgtStr = Number.isFinite(tg) ? tg.toFixed(2) : "—";
  let grok = String(a.aiCoPilot || a.aiVerdict || "")
    .replace(/\s+/g, " ")
    .trim();
  if (grok.length > 600) grok = grok.slice(0, 597) + "…";
  const plan = String(a.plan || "").trim();
  const histLine = historicalMatchesShortP19(a);

  const hi = [];
  if (score >= 90) hi.push("⚡ SCORE 90+ — TOP TIER");
  if (volRatioOfAlertP19(a) >= 3) hi.push("⚡ VOL SURGE 3×+");
  if (hasCatalystSignalP19(a)) hi.push("⚡ CATALYST / NEWS");
  if (hasRegimeOrLevelKeywordsP19(a)) hi.push("⚡ REGIME / LEVEL / REVERSAL — READ FULL GROK");

  const banner = hi.length ? hi.join("\n") + "\n\n" : "";

  return (
    banner +
    `🔥 SOHELATOR ALERT\n` +
    `${sym} - ${play}\n` +
    `SCORE ${score} | EDGE ${edgeStr}\n` +
    `Price: ${priceStr}${chg}\n` +
    `Play: ENTRY @ ${entryStr}\n` +
    `Stop: ${stopStr} | Target: ${tgtStr}\n` +
    `Grok: ${grok || "—"}\n` +
    `Plan: ${plan || "—"}\n` +
    `Historical: ${histLine}`
  );
}

async function relayPrompt19Telegrams(alerts, dedupeSet) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat || !Array.isArray(alerts)) return;
  const cooldowns = await getAlertCooldowns();
  for (let i = 0; i < alerts.length; i++) {
    const a = alerts[i];
    if (Number(a.score) < TELEGRAM_ALERT_MIN_SCORE) continue;
    const sym = String(a.symbol || "").trim().toUpperCase();
    const newScore = Math.round(Number(a.score) || 0);
    const prev = sym ? cooldowns[sym] : null;
    if (prev && typeof prev.firedAt === "number") {
      const within =
        Date.now() - prev.firedAt < ALERT_TELEGRAM_COOLDOWN_MS;
      const lastScore = Math.round(Number(prev.score) || 0);
      const scoreJumped = newScore >= lastScore + ALERT_TELEGRAM_SCORE_JUMP;
      if (within && !scoreJumped) continue;
    }
    const k = `${a.symbol}|${Math.round(Number(a.score))}|${a.alertedAt || ""}|${String(a.alertedAtIso || "")}`;
    if (dedupeSet.has(k)) continue;
    dedupeSet.add(k);
    const text = String(buildTelegramPrompt19Message(a) || "").trim().slice(0, 3900);
    if (!text) continue;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!tgRes.ok) {
        console.warn("cheap-monitor Prompt19 Telegram http", tgRes.status);
        continue;
      }
    } catch (e) {
      console.warn("cheap-monitor Prompt19 Telegram:", e?.message || e);
      continue;
    }
    cooldowns[sym] = { score: newScore, firedAt: Date.now() };
    await setAlertCooldown(sym, newScore);
    await new Promise((r) => setTimeout(r, 300));
  }
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

  let scanBody = { mode: "cheap", suppressTelegram: true };
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
        suppressTelegram: true,
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
      scanBody = { mode: "cheap", suppressTelegram: true };
    }
    out.path = "after_hours_hourly";
    out.afterHoursSlot = afterHoursSlot;
  } else {
    out.path = "rth_5min";
  }

  const telegramDedupe = new Set();

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

    await relayPrompt19Telegrams(alerts, telegramDedupe);

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
          t - Number(prev.at || 0) < 10 * 60 * 1000
        ) {
          doExpensive = false;
          out.expensiveSkipped = "debounced_10m";
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
        suppressTelegram: true,
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
      const expAlerts = Array.isArray(ej.alerts) ? ej.alerts : [];
      await relayPrompt19Telegrams(expAlerts, telegramDedupe);
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
