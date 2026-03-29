const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext } = require("./lib/sohelContext");

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradierGet(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const url = tradierBase() + path + (qs ? "?" + qs : "");
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

const BASE_TICKERS = [
  "NVDA", "TSLA", "SPY", "QQQ", "AAPL", "AMD", "MSFT", "META", "GOOGL",
  "AMZN", "NFLX", "COIN", "MSTR", "PLTR", "ARM", "SMCI", "MU", "AVGO",
  "TSM", "UBER", "HOOD", "SOFI", "IONQ", "RKLB", "CRWD", "PANW", "SNOW",
  "DDOG", "NET", "SHOP", "SQ", "PYPL", "RIVN", "NIO", "LCID",
];

const ETF_BLOCK = new Set([
  "SPY", "QQQ", "DIA", "IWM", "XLK", "XLE", "XLF", "XBI", "XLV", "ARKK",
  "SMH", "VOO", "VTI", "EEM", "GLD", "SLV", "TLT", "HYG", "IWM", "QQQM",
]);

const TICKER_BLOCK = new Set([
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER",
  "FED", "GDP", "CPI", "PPI", "NFP", "FOMC", "USA", "NYSE", "SEC", "IPO",
  "EPS", "ETF",
]);

function extractTickers(text) {
  const u = String(text || "").toUpperCase();
  const m = u.match(/\b[A-Z]{2,5}\b/g) || [];
  return [...new Set(m.filter((t) => t.length >= 2 && !TICKER_BLOCK.has(t)))];
}

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { organic: [] };
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: 10 }),
  });
  return res.json();
}

function scoreTicker(quote, mentions, earningsSet) {
  let score = 0;
  const pct = Math.abs(quote.preMktChange || 0);
  if (pct > 0.5) score += 10;
  if (pct > 1.0) score += 15;
  if (pct > 2.0) score += 20;
  if (pct > 3.0) score += 15;
  const vr = quote.volRatio || 1;
  if (vr > 1.5) score += 15;
  if (vr > 2.0) score += 10;
  if (vr > 3.0) score += 10;
  if (mentions.unusualOptions) score += 25;
  if (mentions.breakingNews) score += 20;
  if (mentions.sectorHot) score += 15;
  if (earningsSet.has(quote.symbol)) score -= 50;
  return Math.max(0, Math.min(100, score));
}

function nyHM() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return {
    h: +p.find((x) => x.type === "hour").value,
    m: +p.find((x) => x.type === "minute").value,
  };
}

async function run925() {
  const { h, m } = nyHM();
  if (h !== 9 || m < 20 || m > 35) {
    return { statusCode: 200, body: JSON.stringify({ skipped: true, reason: "Outside scan window" }) };
  }

  const dateStr = now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const [
    marketNews,
    preMktMovers,
    unusualOptions,
    earnings,
    sectorRotation,
    fedData,
    breakingNews,
  ] = await Promise.all([
    serperSearch(`stock market outlook today ${dateStr}`),
    serperSearch(`pre-market movers gainers losers ${dateStr}`),
    serperSearch(`unusual options activity today ${dateStr}`),
    serperSearch(`earnings reports today ${dateStr}`),
    serperSearch(`sector rotation hot sectors ${dateStr}`),
    serperSearch(`fed economic data release ${dateStr}`),
    serperSearch(`breaking news stocks catalyst ${dateStr}`),
  ]);

  const searches = [
    { data: unusualOptions, key: "unusualOptions" },
    { data: breakingNews, key: "breakingNews" },
    { data: sectorRotation, key: "sectorHot" },
  ];

  const headlines = [];
  const allOrganic = [
    marketNews,
    preMktMovers,
    unusualOptions,
    earnings,
    sectorRotation,
    fedData,
    breakingNews,
  ];
  for (const o of allOrganic) {
    const org = o.organic || [];
    for (let i = 0; i < Math.min(3, org.length); i++) {
      const t = (org[i].title || "") + " — " + (org[i].snippet || "");
      headlines.push(t);
    }
  }

  const macroRe = /FOMC|CPI|PPI|NFP|GDP|Fed|earnings|FOMC|jobs report/i;
  const eventsToday = [];
  for (const h of headlines) {
    if (macroRe.test(h)) eventsToday.push(h.slice(0, 120));
  }

  const hotSectorSyms = ["XLK", "XLE", "XLF", "XBI", "XLV", "ARKK", "SMH"];
  const hotSectors = hotSectorSyms.filter((s) =>
    headlines.some((h) => h.toUpperCase().includes(s))
  );

  let bullWords = 0,
    bearWords = 0;
  const bullL = /\b(rally|surge|bull|gains|higher|breakout|strong)\b/gi;
  const bearL = /\b(drop|fall|bear|selloff|lower|weak|crash)\b/gi;
  for (const h of headlines) {
    const b = h.match(bullL);
    const a = h.match(bearL);
    bullWords += b ? b.length : 0;
    bearWords += a ? a.length : 0;
  }
  const sentiment =
    bullWords > bearWords + 2
      ? "risk-on"
      : bearWords > bullWords + 2
        ? "risk-off"
        : "mixed";

  const tickerMentions = new Map();
  function addTickersFromSearch(data, flags) {
    const org = data.organic || [];
    for (const row of org) {
      const blob = (row.title || "") + " " + (row.snippet || "");
      for (const t of extractTickers(blob)) {
        if (!tickerMentions.has(t)) tickerMentions.set(t, { unusualOptions: false, breakingNews: false, sectorHot: false });
        const m = tickerMentions.get(t);
        Object.assign(m, flags);
      }
    }
  }
  addTickersFromSearch(unusualOptions, { unusualOptions: true });
  addTickersFromSearch(breakingNews, { breakingNews: true });
  addTickersFromSearch(sectorRotation, { sectorHot: true });

  const earningsSet = new Set();
  const orgE = earnings.organic || [];
  for (const row of orgE) {
    const blob = (row.title || "") + " " + (row.snippet || "");
    extractTickers(blob).forEach((t) => earningsSet.add(t));
    if (/earnings/i.test(blob)) {
      extractTickers(blob).forEach((t) => earningsSet.add(t));
    }
  }

  const discovered = [...tickerMentions.keys()].filter(
    (t) => !ETF_BLOCK.has(t) && BASE_TICKERS.indexOf(t) === -1
  );
  const extra = discovered.slice(0, 15);
  const allSyms = [...new Set([...BASE_TICKERS, ...extra, "VIX"])];

  const chunkSize = 40;
  const quotesBySym = {};
  for (let i = 0; i < allSyms.length; i += chunkSize) {
    const chunk = allSyms.slice(i, i + chunkSize).join(",");
    const qd = await tradierGet("/v1/markets/quotes", { symbols: chunk, greeks: "false" });
    const ql = normList(qd.quotes?.quote);
    for (const q of ql) {
      if (q.symbol) quotesBySym[q.symbol] = q;
    }
  }

  const vixQ = quotesBySym["VIX"] || quotesBySym["$VIX"];
  const vix = parseFloat(vixQ?.last ?? vixQ?.close ?? 20) || 20;
  const spyQ = quotesBySym["SPY"];
  const qqqQ = quotesBySym["QQQ"];
  const spyPrev = parseFloat(spyQ?.prevclose ?? spyQ?.open ?? 0);
  const qqqPrev = parseFloat(qqqQ?.prevclose ?? qqqQ?.open ?? 0);
  const spyLast = parseFloat(spyQ?.last ?? spyQ?.close ?? 0);
  const qqqLast = parseFloat(qqqQ?.last ?? qqqQ?.close ?? 0);
  const spyPct = spyPrev ? ((spyLast - spyPrev) / spyPrev) * 100 : 0;
  const qqqPct = qqqPrev ? ((qqqLast - qqqPrev) / qqqPrev) * 100 : 0;

  const scored = [];
  for (const sym of allSyms) {
    if (sym === "VIX" || sym === "$VIX") continue;
    const q = quotesBySym[sym];
    if (!q) continue;
    const last = parseFloat(q.last ?? q.close ?? q.bid ?? 0);
    const prev = parseFloat(q.prevclose ?? q.close ?? last);
    const vol = parseFloat(q.volume ?? 0);
    const avgVol = parseFloat(
      q.average_volume ?? q.avg_volume ?? (vol || 1)
    );
    if (last <= 8 || avgVol < 300000) continue;
    const preMktChange = prev ? ((last - prev) / prev) * 100 : 0;
    const volRatio = avgVol > 0 ? vol / avgVol : 1;
    const mentions = tickerMentions.get(sym) || {
      unusualOptions: false,
      breakingNews: false,
      sectorHot: false,
    };
    const quote = {
      symbol: sym,
      last,
      prev,
      preMktChange,
      volRatio,
      volume: vol,
      average_volume: avgVol,
    };
    const score = scoreTicker(quote, mentions, earningsSet);
    let newsReason = "";
    if (mentions.unusualOptions) newsReason = "Unusual options";
    else if (mentions.breakingNews) newsReason = "Breaking news";
    else if (mentions.sectorHot) newsReason = "Sector rotation";
    scored.push({ ...quote, score, newsReason });
  }

  const watchlistAvoid = scored
    .filter((x) => earningsSet.has(x.symbol))
    .map((x) => ({ symbol: x.symbol, reason: "earnings" }));

  const eligible = scored.filter((x) => !earningsSet.has(x.symbol));
  const pos = eligible.filter((x) => x.preMktChange > 0).sort((a, b) => b.score - a.score);
  const neg = eligible.filter((x) => x.preMktChange < 0).sort((a, b) => b.score - a.score);

  const watchlistBull = pos
    .filter((x) => x.score > 30)
    .slice(0, 5)
    .map((x) => ({
      symbol: x.symbol,
      preMktChange: x.preMktChange,
      volRatio: x.volRatio,
      score: x.score,
      newsReason: x.newsReason,
    }));
  const watchlistBear = neg
    .filter((x) => x.score > 30)
    .slice(0, 3)
    .map((x) => ({
      symbol: x.symbol,
      preMktChange: x.preMktChange,
      volRatio: x.volRatio,
      score: x.score,
    }));

  const model =
    process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  let analysis = "Configure ANTHROPIC_API_KEY.";
  if (key) {
    const system = withSohelContext(
      `You are Sohel's personal options trading partner. It's 9:25am — market opens in 5 minutes. Give him his morning briefing like you're sitting right next to him watching pre-market together.

Be direct and specific. Give exact tickers. Warn him clearly if today looks dangerous. Talk like his trading partner, not a robot.

Also include: recommended hold duration (SWING vs DAY) for each highlighted setup; if today is Friday, weekend hold assessment for each name; Monday catalyst watch for any weekend holds.`
    );
    const user = `Morning. Here's what I'm seeing:

DATE: ${dateStr} — 9:25am EST
Market opens in 5 minutes.

MARKET CONTEXT:
VIX: ${vix} — ${vix < 15 ? "VERY LOW FEAR" : vix < 20 ? "LOW FEAR" : vix < 25 ? "MODERATE" : vix < 30 ? "ELEVATED" : "HIGH FEAR"}
SPY pre-market: ${spyPct.toFixed(2)}% (${spyPct > 0 ? "bullish" : "bearish"})
QQQ pre-market: ${qqqPct.toFixed(2)}% (${qqqPct > 0 ? "bullish" : "bearish"})
Sentiment: ${sentiment}

KEY EVENTS TODAY:
${eventsToday.length > 0 ? eventsToday.map((e) => "• " + e).join("\n") : "• No major scheduled events"}

HOT SECTORS: ${hotSectors.join(", ") || "No clear sector rotation"}

TOP BULL CANDIDATES:
${watchlistBull.map((t) => `• ${t.symbol}: ${t.preMktChange > 0 ? "+" : ""}${t.preMktChange.toFixed(2)}% pre-mkt | Vol: ${t.volRatio.toFixed(1)}x avg | Score: ${t.score}/100${t.newsReason ? " | " + t.newsReason : ""}`).join("\n")}

BEAR CANDIDATES:
${watchlistBear.map((t) => `• ${t.symbol}: ${t.preMktChange.toFixed(2)}% | Score: ${t.score}/100`).join("\n") || "• None notable"}

AVOID (earnings today):
${watchlistAvoid.map((t) => `• ${t.symbol} — BINARY RISK`).join("\n") || "• None"}

TOP HEADLINES:
${headlines.slice(0, 10).map((h, i) => `${i + 1}. ${h}`).join("\n")}

Give me:
1. What kind of market are we walking into — trending, choppy, dangerous, or opportunity-rich?
2. The single best play for today — exact ticker, direction (calls or puts), why, what strike/expiry range to target at open
3. One backup play to watch
4. What to completely avoid today and exact reason
5. Any risks before I start trading
6. Your 2-sentence game plan for my day

Be conversational. I'm reading this on my phone right before open.`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const claudeData = await claudeRes.json();
    analysis =
      claudeData.content?.[0]?.text ||
      claudeData.error?.message ||
      "No analysis.";
  }

  const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const scanData = {
    type: "premarket_925",
    date: dateStr,
    timestamp: Date.now(),
    marketContext: {
      vix,
      spyPct,
      qqqPct,
      sentiment,
      eventsToday,
      hotSectors,
    },
    watchlistBull,
    watchlistBear,
    watchlistAvoid,
    headlines: headlines.slice(0, 10),
    claudeAnalysis: analysis,
    model: process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6",
  };
  await store.setJSON("scan_925_latest", scanData);
  await store.setJSON("scan_925_" + dateStr.replace(/\s/g, "_"), scanData);

  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (bot && chat) {
    const vixEmoji = vix < 18 ? "🟢" : vix < 25 ? "🟡" : "🔴";
    const msg = `🌅 <b>SOHELATOR — 9:25 MORNING BRIEF</b>
${dateStr} | Opens in 5 min

${analysis}

━━━━━━━━━━━━━━━━━━
${vixEmoji} <b>VIX: ${vix.toFixed(2)}</b> | SPY: ${spyPct >= 0 ? "+" : ""}${spyPct.toFixed(2)}% | QQQ: ${qqqPct >= 0 ? "+" : ""}${qqqPct.toFixed(2)}%

👀 <b>WATCHLIST:</b>
${watchlistBull.map((t) => `✅ ${t.symbol} +${t.preMktChange.toFixed(1)}% pre-mkt`).join("\n")}
${watchlistBear.map((t) => `🔴 ${t.symbol} ${t.preMktChange.toFixed(1)}% pre-mkt`).join("\n")}
${watchlistAvoid.map((t) => `⚠️ ${t.symbol} — SKIP (earnings)`).join("\n")}
━━━━━━━━━━━━━━━━━━
📊 <i>9:55 opening range scan coming...</i>`;
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: msg,
        parse_mode: "HTML",
      }),
    });
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true, scanData }) };
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
    const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
    const data = await store.get("scan_925_latest", { type: "json" });
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(data || null),
    };
  }
  return run925();
}

exports.handler = schedule("30 14 * * 1-5", httpHandler);
