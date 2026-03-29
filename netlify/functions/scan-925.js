const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const { getMemoryContext } = require("./lib/memory");
const { tradierGet, normList } = require("./lib/tradierClient");
const { checkEarnings } = require("./lib/earnings");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { calculateGEX } = require("./lib/gex");
const { calculateRegime } = require("./lib/marketRegime");

const ETF_BLOCK = new Set([
  "SPY", "QQQ", "DIA", "IWM", "XLK", "XLE", "XLF", "XBI", "XLV", "ARKK",
  "SMH", "VOO", "VTI", "EEM", "GLD", "SLV", "TLT", "HYG", "QQQM", "BITO",
  "UUP", "VIX",
]);

const COMMON_WORDS = new Set([
  "A", "I", "AT", "BE", "DO", "GO", "IF", "IN", "IS", "IT", "NO", "OF", "ON",
  "OR", "SO", "TO", "UP", "US", "WE", "AI", "CEO", "CFO", "IPO", "ETF", "SEC",
  "FDA", "GDP", "CPI", "NFP", "PCE", "FED", "ECB", "IMF", "NYSE", "NASDAQ",
  "DOW", "SPX", "VIX", "USA", "USD", "EUR", "GBP", "EPS", "PE", "EV", "ML",
  "ATH", "ATL", "HOD", "LOD", "EOD", "THE", "AND", "FOR", "ARE", "BUT", "NOT",
  "ALL", "CAN", "PUT", "SAY", "MAY", "NOW", "SEE", "WHO", "ITS", "HAS", "HAD",
  "WAS", "ONE", "OUR", "OUT", "DAY", "GET", "HOW", "NEW", "WAY", "USE", "MAN",
]);

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

function extractTickersFromSearches(searchResults) {
  const allText = searchResults
    .flatMap((r) => r.organic || [])
    .map((row) => `${row.title || ""} ${row.snippet || ""}`)
    .join(" ");

  const tickerPattern = /\b([A-Z]{1,5})\b/g;
  const matches = allText.match(tickerPattern) || [];
  const frequency = {};
  for (const t of matches) {
    if (COMMON_WORDS.has(t)) continue;
    frequency[t] = (frequency[t] || 0) + 1;
  }

  const discovered = [
    ...new Set(
      matches.filter(
        (t) =>
          !COMMON_WORDS.has(t) && t.length >= 2 && t.length <= 5
      )
    ),
  ];

  return { tickers: discovered, frequency };
}

function scoreCandidate(quote, frequency, vixLevel, spyPct) {
  if (!quote) return -100;
  const price = +quote.last || +quote.close || 0;
  const avgVol = +quote.average_volume || +quote.avg_volume || 0;
  const vol = +quote.volume || 0;
  const prevClose = +quote.prevclose || price;
  const sym = quote.symbol;

  if (price < 8) return -100;
  if (avgVol < 300000) return -100;
  if (!price) return -100;
  if (["SPY", "QQQ", "VIX", "IWM", "DIA"].includes(sym)) return -100;

  let score = 0;
  const preMktPct =
    prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;
  const absPct = Math.abs(preMktPct);
  if (absPct > 5) score += 50;
  else if (absPct > 3) score += 40;
  else if (absPct > 2) score += 30;
  else if (absPct > 1) score += 20;
  else if (absPct > 0.5) score += 10;

  const volRatio = avgVol > 0 ? vol / avgVol : 0;
  if (volRatio > 3) score += 30;
  else if (volRatio > 2) score += 20;
  else if (volRatio > 1.5) score += 10;

  const mentions = frequency[sym] || 0;
  score += Math.min(mentions * 5, 25);

  if (preMktPct > 0 && spyPct > 0) score += 8;
  if (preMktPct < 0 && spyPct < 0) score += 8;
  if (vixLevel < 18) score += 5;

  return score;
}

function detectThemes(headlines) {
  const text = headlines.join(" ").toLowerCase();
  const themes = [];
  if (/ai|artificial intelligence|nvidia|chip|semi/.test(text)) {
    themes.push("AI/Semis hot");
  }
  if (/rate|fed|fomc|powell|inflation|cpi/.test(text)) {
    themes.push("Fed/macro in focus");
  }
  if (/energy|oil|crude|opec/.test(text)) themes.push("Energy moving");
  if (/crypto|bitcoin|ethereum|coin/.test(text)) {
    themes.push("Crypto catalyst");
  }
  if (/biotech|fda|drug|clinical/.test(text)) themes.push("Biotech news");
  if (/bank|financial|earnings|revenue/.test(text)) {
    themes.push("Financials/earnings");
  }
  if (/tariff|trade|china|geopolit/.test(text)) {
    themes.push("Macro/geopolitical");
  }
  if (/short squeeze|squeeze|reddit/.test(text)) {
    themes.push("Squeeze potential");
  }
  return themes.length ? themes : ["No dominant theme"];
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
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: "Outside scan window" }),
    };
  }

  const now = new Date();
  const dateStr = now.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const searches = await Promise.all([
    serperSearch(
      `stocks biggest pre-market movers gainers losers today ${dateStr}`
    ),
    serperSearch(
      `unusual options activity flow calls puts today ${dateStr}`
    ),
    serperSearch(
      `breaking stock news catalyst upgrade downgrade today ${dateStr}`
    ),
    serperSearch(`hot sectors stock market rotation today ${dateStr}`),
    serperSearch(
      `earnings reaction pre-market beat miss today ${dateStr}`
    ),
    serperSearch(
      `stock market outlook pre-market futures today ${dateStr}`
    ),
    serperSearch(
      `FDA approval merger acquisition IPO stock news today ${dateStr}`
    ),
    serperSearch(
      `large options trades block sweep unusual today ${dateStr}`
    ),
  ]);

  const { tickers, frequency } = extractTickersFromSearches(searches);

  const contextTickers = ["SPY", "QQQ", "VIX", "IWM", "DIA"];
  const candidateTickers = [
    ...new Set([
      ...tickers.filter((t) => !ETF_BLOCK.has(t)),
      ...contextTickers,
    ]),
  ];

  const quotesBySym = {};
  const chunkSize = 80;
  for (let i = 0; i < candidateTickers.length; i += chunkSize) {
    const chunk = candidateTickers.slice(i, i + chunkSize).join(",");
    if (!chunk.trim()) continue;
    try {
      const qd = await tradierGet("/v1/markets/quotes", {
        symbols: chunk,
        greeks: "false",
      });
      for (const q of normList(qd.quotes?.quote)) {
        if (q.symbol) quotesBySym[q.symbol] = q;
      }
    } catch (e) {
      console.error("quotes chunk", e);
    }
  }

  const spy = quotesBySym.SPY;
  const qqq = quotesBySym.QQQ;
  const vixQ = quotesBySym.VIX;
  const vixLevel = +vixQ?.last || +vixQ?.close || 18;
  const spyPrev = +spy?.prevclose || 0;
  const qqqPrev = +qqq?.prevclose || 0;
  const spyLast = +spy?.last || +spy?.close || 0;
  const qqqLast = +qqq?.last || +qqq?.close || 0;
  const spyPreMktPct = spyPrev ? ((spyLast - spyPrev) / spyPrev) * 100 : 0;
  const qqqPreMktPct = qqqPrev ? ((qqqLast - qqqPrev) / qqqPrev) * 100 : 0;

  const regime = calculateRegime({
    vix: vixLevel,
    spyChange: spyPreMktPct,
    qqqChange: qqqPreMktPct,
    spyAdx: 22,
    spyRsi: 50,
    spyVwapDist: 0,
  });

  const scored = candidateTickers
    .filter((t) => !["SPY", "QQQ", "VIX", "IWM", "DIA"].includes(t))
    .map((ticker) => {
      const quote = quotesBySym[ticker];
      const prev = quote ? +quote.prevclose || +quote.close || 0 : 0;
      const last = quote ? +quote.last || +quote.close || 0 : 0;
      const preMktPct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
      return {
        ticker,
        quote,
        score: scoreCandidate(quote, frequency, vixLevel, spyPreMktPct),
        preMktPct,
        mentions: frequency[ticker] || 0,
      };
    })
    .filter((t) => t.score > 0 && t.quote)
    .sort((a, b) => b.score - a.score);

  const topOverall = scored.slice(0, 8);
  const topBull = scored.filter((t) => t.preMktPct > 0).slice(0, 5);
  const topBear = scored.filter((t) => t.preMktPct < 0).slice(0, 3);

  const verifiedCandidates = [];
  for (const candidate of topOverall.slice(0, 12)) {
    try {
      const expData = await tradierGet(
        "/v1/markets/options/expirations",
        { symbol: candidate.ticker }
      );
      const exps = expData.expirations?.date;
      const ok = exps && (Array.isArray(exps) ? exps.length > 0 : true);
      if (ok) {
        verifiedCandidates.push({ ...candidate, hasOptions: true });
      }
    } catch {
      /* skip */
    }
    if (verifiedCandidates.length >= 8) break;
  }

  const earningsCheck = await Promise.allSettled(
    verifiedCandidates.map((c) => checkEarnings(c.ticker))
  );

  const finalCandidates = verifiedCandidates
    .map((c, i) => ({
      ...c,
      earnings:
        earningsCheck[i].status === "fulfilled"
          ? earningsCheck[i].value
          : null,
    }))
    .filter((c) => !c.earnings?.isThisWeek);

  const avoidList = verifiedCandidates
    .map((c, i) => ({
      ticker: c.ticker,
      earnings:
        earningsCheck[i].status === "fulfilled"
          ? earningsCheck[i].value
          : null,
    }))
    .filter((x) => x.earnings?.isThisWeek);

  const bullCandidates = finalCandidates.filter((c) => c.preMktPct > 0);
  const bearCandidates = finalCandidates.filter((c) => c.preMktPct < 0);

  const allHeadlines = searches
    .flatMap((r) => r.organic || [])
    .map((r) => r.title || r.snippet)
    .filter(Boolean)
    .slice(0, 20);

  const todayThemes = detectThemes(allHeadlines);
  const sentiment =
    spyPreMktPct > 0.5
      ? "RISK-ON — bulls have control pre-market"
      : spyPreMktPct < -0.5
        ? "RISK-OFF — defensive, bears leading"
        : vixLevel > 22
          ? "ELEVATED FEAR — be selective"
          : "NEUTRAL — wait for direction at open";

  let gexSpy = null;
  try {
    if (spyLast > 0) gexSpy = await calculateGEX("SPY", spyLast);
  } catch (e) {
    console.error("gex spy", e);
  }

  const masterTickers = finalCandidates.slice(0, 5).map((c) => c.ticker);
  const masterSettled = await Promise.allSettled(
    masterTickers.map((t) => getMasterAnalysis(t))
  );
  const masterSnapshots = masterSettled.map((r, i) => ({
    ticker: masterTickers[i],
    ok: r.status === "fulfilled",
    data: r.status === "fulfilled" ? r.value : null,
  }));

  const masterDigest = masterSnapshots
    .filter((m) => m.ok && m.data)
    .map(
      (m) =>
        `${m.ticker}: ${m.data.summary}\n${m.data.gex?.interpretation ? "GEX: " + m.data.gex.interpretation.slice(0, 120) + "…" : ""}`
    )
    .join("\n\n");

  const model =
    process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  let analysis = "Configure ANTHROPIC_API_KEY.";
  let mem925 = {
    insights: [],
    allTickerStats: [],
    allPatternStats: [],
    behavioralStats: null,
  };
  try {
    mem925 = await getMemoryContext();
  } catch (e) {
    console.error("scan-925 memory", e);
  }
  const leadMaster =
    masterSnapshots.find((m) => m.ok && m.data)?.data || null;
  const leadTicker = masterTickers[0] || "SPY";
  const leadPrice =
    leadMaster?.price != null ? leadMaster.price : spyLast;
  const morningContext = buildTradingContext(
    leadMaster,
    leadTicker,
    leadPrice,
    mem925
  );

  if (key) {
    const system = withSohelContext(
      `It's 9:25am. Market opens in 5 minutes.
Give Sohel his morning brief.
Format: MARKET / #1 PLAY / #2 WATCH /
AVOID / RISK / GAME PLAN.
Maximum 150 words. He reads this on 
his phone before the bell.`,
      morningContext
    );

    const user = `Morning. Market opens in 5 minutes.

MARKET CONTEXT:
VIX: ${vixLevel} | SPY: ${spyPreMktPct.toFixed(2)}% | QQQ: ${qqqPreMktPct.toFixed(2)}%
Sentiment: ${sentiment}
Today's themes: ${todayThemes.join(", ")}
Regime: ${regime.primary || "n/a"}

MARKET GEX (SPY proxy):
${gexSpy ? `${gexSpy.gexRegime} — ${gexSpy.interpretation}` : "N/A"}

DISCOVERED FROM LIVE MARKET (pre-market):

BULL CANDIDATES (heating up):
${
  bullCandidates
    .map(
      (c) =>
        `${c.ticker}: +${c.preMktPct.toFixed(2)}% pre-mkt | Score: ${c.score} | Mentioned ${c.mentions}x in news`
    )
    .join("\n") || "None notable yet"
}

BEAR CANDIDATES (selling off):
${
  bearCandidates
    .map(
      (c) =>
        `${c.ticker}: ${c.preMktPct.toFixed(2)}% pre-mkt | Score: ${c.score}`
    )
    .join("\n") || "None notable"
}

AVOID (earnings this week):
${
  avoidList
    .map((c) => `${c.ticker} — ${c.earnings?.warning || "earnings"}`)
    .join("\n") || "None flagged"
}

DEEP DIVE (Tradier + master stack, top names):
${masterDigest || "—"}

TODAY'S HEADLINES (sample):
${allHeadlines.slice(0, 8).join("\n")}`;

    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1000,
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

  const watchlistBull = bullCandidates.slice(0, 5).map((c) => ({
    symbol: c.ticker,
    preMktChange: c.preMktPct,
    volRatio:
      c.quote?.average_volume > 0
        ? (+c.quote.volume || 0) / +c.quote.average_volume
        : 0,
    score: c.score,
    mentions: c.mentions,
  }));
  const watchlistBear = bearCandidates.slice(0, 3).map((c) => ({
    symbol: c.ticker,
    preMktChange: c.preMktPct,
    score: c.score,
  }));
  const watchlistAvoid = avoidList.map((c) => ({
    symbol: c.ticker,
    reason: "earnings",
    warning: c.earnings?.warning,
  }));

  const scanData = {
    type: "premarket_925",
    date: dateStr,
    timestamp: Date.now(),
    marketContext: {
      vix: vixLevel,
      spyPct: spyPreMktPct,
      qqqPct: qqqPreMktPct,
      sentiment,
      todayThemes,
      regime: regime.primary,
    },
    gexSpy,
    masterSnapshots,
    watchlistBull,
    watchlistBear,
    watchlistAvoid,
    headlines: allHeadlines.slice(0, 10),
    claudeAnalysis: analysis,
    model: process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6",
  };

  await store.setJSON("scan_925_latest", scanData);
  await store.setJSON("scan_925_" + dateStr.replace(/\s/g, "_"), scanData);

  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (bot && chat) {
    const vixEmoji = vixLevel < 18 ? "🟢" : vixLevel < 25 ? "🟡" : "🔴";
    const gexLine = gexSpy
      ? `\n<b>GEX (SPY):</b> ${gexSpy.gexRegime} — ${escapeHtml(gexSpy.interpretation.slice(0, 140))}…`
      : "";
    const flowLine = masterSnapshots.find(
      (m) => m.ok && m.data?.optionsFlow?.smartMoneyBias
    );
    const flowBit = flowLine?.data?.optionsFlow
      ? `\n<b>Flow bias:</b> ${flowLine.data.optionsFlow.smartMoneyBias}`
      : "";
    const msg = `🌅 <b>SOHELATOR — 9:25 MORNING BRIEF</b>
${dateStr} | Opens in 5 min

${escapeHtml(analysis)}
${gexLine}${flowBit}
━━━━━━━━━━━━━━━━━━
${vixEmoji} <b>VIX: ${vixLevel.toFixed(2)}</b> | SPY: ${spyPreMktPct >= 0 ? "+" : ""}${spyPreMktPct.toFixed(2)}% | QQQ: ${qqqPreMktPct >= 0 ? "+" : ""}${qqqPreMktPct.toFixed(2)}%

👀 <b>DISCOVERED:</b>
${watchlistBull.map((t) => `✅ ${t.symbol} +${t.preMktChange.toFixed(1)}% (score ${t.score})`).join("\n")}
${watchlistBear.map((t) => `🔴 ${t.symbol} ${t.preMktChange.toFixed(1)}%`).join("\n")}
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

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
