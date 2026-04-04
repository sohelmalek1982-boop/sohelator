const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext } = require("./lib/sohelContext");
const { tradierGet, normList } = require("./lib/tradierClient");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { parseHistoryDays } = require("./lib/multiTimeframe");
const { calcRSI } = require("./lib/indicatorsShared");

const WATCH = [
  "NVDA", "TSLA", "SPY", "QQQ", "AAPL", "AMD", "MSFT", "META", "GOOGL",
  "AMZN", "NFLX", "COIN", "MSTR", "PLTR", "ARM", "SMCI", "MU", "AVGO",
  "TSM", "UBER",
];

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { organic: [] };
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: 8 }),
  });
  return res.json();
}

function nextMondayLabel() {
  const d = new Date();
  const day = d.getUTCDay();
  const add = day === 0 ? 1 : 8 - day;
  const m = new Date(d);
  m.setUTCDate(d.getUTCDate() + add);
  return m.toISOString().slice(0, 10);
}

async function dailySnapshot(symbol) {
  const end = new Date().toISOString().slice(0, 10);
  const start = new Date(Date.now() - 400 * 86400000)
    .toISOString()
    .slice(0, 10);
  const h = await tradierGet("/v1/markets/history", {
    symbol,
    interval: "daily",
    start,
    end,
  });
  const days = parseHistoryDays(h.history?.day);
  const last = days[days.length - 1];
  if (!last) return null;
  const closes = days.map((x) => x.close);
  const rsi = closes.length > 15 ? calcRSI(closes, 14) : 50;
  return {
    symbol,
    close: last.close,
    rsi: +rsi.toFixed(1),
    trend:
      closes.length > 2 && last.close > closes[closes.length - 5]
        ? "up"
        : "fade",
  };
}

async function runWeekendBuild() {
  const weekOf = nextMondayLabel();
  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const [earningsWeek, fedMacro, sectorNews] = await Promise.all([
    serperSearch(`stocks earnings calendar week of ${weekOf} 2026`),
    serperSearch(`Fed FOMC economic calendar ${weekOf} 2026 CPI NFP`),
    serperSearch(`stock market sector news week ahead ${weekOf}`),
  ]);

  const headlines = [earningsWeek, fedMacro, sectorNews]
    .flatMap((r) => r.organic || [])
    .map((o) => o.title || o.snippet)
    .filter(Boolean)
    .slice(0, 12);

  const snapshots = [];
  for (const sym of WATCH.slice(0, 12)) {
    try {
      const snap = await dailySnapshot(sym);
      if (snap) snapshots.push(snap);
    } catch {
      /* skip */
    }
  }

  const masterSyms = WATCH.slice(0, 4);
  const masterTop = await Promise.allSettled(
    masterSyms.map((t) => getMasterAnalysis(t))
  );
  const masterLines = masterTop
    .map((r, i) =>
      r.status === "fulfilled" && r.value
        ? `${masterSyms[i]}: ${r.value.summary}`
        : null
    )
    .filter(Boolean);

  const model =
    process.env.ANTHROPIC_MODEL_WEEKEND || "claude-opus-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  let claudeAnalysis = "Configure ANTHROPIC_API_KEY.";
  if (key) {
    const system = withSohelContext(
      `You are Sohel's swing options strategist. Weekly prep for Monday open.
Output 5–7 crisp sentences: what to watch next week, how to size risk, and which themes matter for 1–3 day option swings.`,
      ""
    );
    const user = `Week ahead of ${weekOf} (Monday).

DAILY SNAPSHOTS (Tradier):
${snapshots.map((s) => `${s.symbol}: $${s.close.toFixed(2)} RSI ${s.rsi} (${s.trend})`).join("\n")}

MASTER STACK (sample tickers):
${masterLines.join("\n")}

CATALYST HEADLINES (Serper):
${headlines.join("\n")}

Give: (1) tone for the week (2) best 3 tickers to stalk (3) what to avoid (4) macro landmines.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json();
    claudeAnalysis =
      data.content?.[0]?.text ||
      data.error?.message ||
      "No analysis.";
  }

  const intel = {
    type: "weekend_intel",
    builtAt: Date.now(),
    weekOf,
    dateStr,
    headlines,
    snapshots,
    masterLines,
    claudeAnalysis,
    model,
  };

  const store = getStore('morning-scans');
  await store.setJSON("weekend_intel_latest", intel);
  await store.setJSON("weekend_intel_" + weekOf, intel);

  return { statusCode: 200, body: JSON.stringify({ ok: true, intel }) };
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function httpHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod === "GET") {
    const store = getStore('morning-scans');
    const data = await store.get("weekend_intel_latest", { type: "json" });
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(data || null),
    };
  }
  return runWeekendBuild();
}

exports.handler = schedule("0 15 * * 6", httpHandler);
