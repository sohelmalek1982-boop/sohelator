/**
 * 1:00 PM ET afternoon brief: compare 9:25 morning plan vs current tape,
 * what worked / what didn't, second-half focus.
 */

const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const { getMemoryContext } = require("./lib/memory.cjs");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { recordJobOk, recordJobError } = require("./lib/jobHealth");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function todayStrEt() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function pctFromQuote(q) {
  if (!q) return null;
  const prev = parseFloat(q.prevclose) || parseFloat(q.close) || 0;
  const last = parseFloat(q.last) || parseFloat(q.bid) || parseFloat(q.ask) || 0;
  if (!(prev > 0) || !(last > 0)) return null;
  return ((last - prev) / prev) * 100;
}

async function runBrief1pm() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: "ANTHROPIC_API_KEY not set" }),
    };
  }

  const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });

  const morning925 = await store.get("scan_925_latest", { type: "json" });
  const today = todayStrEt();
  const morningIsToday =
    morning925 &&
    String(morning925.date || "").trim() === String(today).trim();

  const { getMarketTapeSnapshot } = await import("../../src/lib/marketTape.js");
  const { callClaudeWithFallback } = await import("../../src/lib/claude.js");
  const { getQuote } = await import("../../src/lib/tradier.js");

  let afternoonTape = null;
  try {
    afternoonTape = await getMarketTapeSnapshot();
  } catch (e) {
    console.warn("brief-1pm afternoonTape", e?.message || e);
  }

  let spyQ = null;
  try {
    spyQ = await getQuote("SPY");
  } catch (e) {
    console.warn("brief-1pm SPY quote", e?.message || e);
  }
  const spyPctNow = pctFromQuote(spyQ);

  let memCtx = {
    insights: [],
    allTickerStats: [],
    allPatternStats: [],
    behavioralStats: null,
  };
  try {
    memCtx = await getMemoryContext();
  } catch (e) {
    console.warn("brief-1pm memory", e?.message || e);
  }

  const leadTicker =
    (morning925?.watchlistBull && morning925.watchlistBull[0]?.symbol) ||
    (morning925?.watchlistBear && morning925.watchlistBear[0]?.symbol) ||
    "SPY";

  let leadMaster = null;
  try {
    leadMaster = await getMasterAnalysis(leadTicker);
  } catch (e) {
    console.warn("brief-1pm master", leadTicker, e?.message || e);
  }
  if (!leadMaster) {
    try {
      leadMaster = await getMasterAnalysis("SPY");
    } catch (e) {
      /* ignore */
    }
  }

  let leadPrice =
    leadMaster?.price != null && isFinite(Number(leadMaster.price))
      ? Number(leadMaster.price)
      : 0;
  if (!(leadPrice > 0) && spyQ) {
    leadPrice =
      parseFloat(spyQ.last) ||
      parseFloat(spyQ.bid) ||
      parseFloat(spyQ.ask) ||
      0;
  }

  const tradingCtx = buildTradingContext(
    leadMaster,
    leadTicker,
    leadPrice,
    memCtx
  );

  const morningPlanText = morning925?.claudeAnalysis
    ? String(morning925.claudeAnalysis).slice(0, 12000)
    : "(No 9:25 brief in blob — run scan-925 or check NETLIFY Blobs.)";

  const morningTapeJson = morning925?.marketTape
    ? JSON.stringify(morning925.marketTape)
    : "none";

  const user = `=== TODAY (ET) ===
${today}

=== MORNING 9:25 BRIEF IS FROM TODAY ===
${morningIsToday ? "YES" : "NO — compare carefully; stored morning data may be from another session."}

=== MORNING PLAN (9:25 Claude text) ===
${morningPlanText}

=== MORNING MARKET CONTEXT (JSON) ===
${JSON.stringify(morning925?.marketContext || {})}

=== MORNING TAPE SNAPSHOT (JSON, if saved) ===
${morningTapeJson}

=== MORNING WATCHLISTS ===
Bull: ${(morning925?.watchlistBull || []).map((w) => w.symbol).join(", ") || "—"}
Bear: ${(morning925?.watchlistBear || []).map((w) => w.symbol).join(", ") || "—"}

=== NOW (~1 PM ET) — CURRENT FULL MARKET TAPE ===
${afternoonTape ? JSON.stringify(afternoonTape) : "unavailable"}

SPY approx % change vs prior close: ${spyPctNow != null ? spyPctNow.toFixed(2) + "%" : "—"}
`;

  const system = withSohelContext(
    `It's 1:00 PM Eastern. The morning session is over; you're updating Sohel for the **second half** of the trading day.

You have:
- The **9:25 morning plan** (themes, watchlist, tape snapshot)
- The **current ~1 PM tape** (indices, sectors, macro)

Your job:
1. Compare morning vs reality: what played out, what didn't.
2. Say clearly what the morning call **got right** and **got wrong or missed** (no sugarcoating).
3. What to watch and how to pursue edge **from now through the close** (not generic advice).

Use ONLY the data provided + sound judgment. Do not invent prices or headlines.

Use these Markdown sections in order:

## MORNING VS REALITY
## WHAT WE GOT RIGHT
## WHAT WE GOT WRONG OR MISSED
## SECOND HALF — WHAT TO WATCH
## BEST WAYS TO MAKE $ THIS AFTERNOON
## BE CAREFUL

Max ~700 words. No JSON in the prose. Trader-to-trader tone.`,
    tradingCtx
  );

  const fullPrompt = `${system}\n\n---\n\n${user}`;

  let analysis = "Brief unavailable.";
  try {
    analysis = await callClaudeWithFallback(fullPrompt, 2800);
  } catch (e) {
    console.error("brief-1pm Claude", e);
    analysis = `Brief failed: ${e?.message || e}`;
  }

  const scanData = {
    type: "brief_1pm",
    date: today,
    timestamp: Date.now(),
    morningDate: morning925?.date || null,
    morningIsToday,
    afternoonTape,
    spyPctNow,
    claudeAnalysis: analysis,
    model: process.env.ANTHROPIC_MODEL_PREMARKET || "claude-sonnet-4-6",
  };

  try {
    await store.setJSON("brief_1pm_latest", scanData);
    await store.setJSON(
      "brief_1pm_" + today.replace(/\s/g, "_"),
      scanData
    );
  } catch (e) {
    console.error("brief-1pm blob write", e);
  }

  const _b = process.env.TELEGRAM_BOT_TOKEN;
  const _c = process.env.TELEGRAM_CHAT_ID;
  if (_b && _c && scanData.claudeAnalysis) {
    const _brief = String(scanData.claudeAnalysis).slice(0, 3900);
    fetch(`https://api.telegram.org/bot${_b}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: _c,
        text: `🕐 1:00 PM BRIEF — SOHELATOR\n\n${_brief}`.slice(0, 4000),
        disable_web_page_preview: true,
      }),
    }).catch((e) => console.warn("brief-1pm Telegram:", e?.message));
  }

  try {
    await recordJobOk("brief-1pm", {
      timestamp: scanData.timestamp,
      morningIsToday,
    });
  } catch (e) {
    console.error("recordJobOk brief-1pm", e);
  }

  return {
    statusCode: 200,
    headers: { ...cors, "Content-Type": "application/json" },
    body: JSON.stringify({ ok: true, scanData }),
  };
}

async function httpHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod === "GET") {
    const store = getStore({
      name: "morning-scans",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });
    const data = await store.get("brief_1pm_latest", { type: "json" });
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(data || null),
    };
  }
  return runBrief1pm().catch(async (e) => {
    console.error(e);
    try {
      await recordJobError("brief-1pm", e.message);
    } catch (err) {
      /* ignore */
    }
    return {
      statusCode: 500,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify({ ok: false, error: e.message }),
    };
  });
}

/** 17:00 UTC Mon–Fri ≈ 1:00 PM Eastern during EDT (Mar–Nov). Adjust to 18:00 UTC in EST-only if needed. */
exports.handler = schedule("0 17 * * 1-5", httpHandler);
