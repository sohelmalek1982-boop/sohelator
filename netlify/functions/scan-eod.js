const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const { getMemoryContext } = require("./lib/memory");

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
  const res = await fetch(tradierBase() + path + (qs ? "?" + qs : ""), {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
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

function dateStrUs() {
  return new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function isSameNyDay(ts) {
  const ny = new Date(ts).toLocaleDateString("en-US", {
    timeZone: "America/New_York",
  });
  const now = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
  });
  return ny === now;
}

async function listAlertJsonKeys(alertStore) {
  const keys = [];
  try {
    for await (const page of alertStore.list({
      prefix: "alert_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        if (b.key) keys.push(b.key);
      }
    }
  } catch (e) {
    console.error("list alerts", e);
  }
  return keys;
}

async function runEod() {
  const { h, m } = nyHM();
  if (h !== 16 || m > 15) {
    return {
      statusCode: 200,
      body: JSON.stringify({ skipped: true, reason: "Outside EOD window (4:00–4:15pm ET)" }),
    };
  }

  const dateStr = dateStrUs();
  const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const alertStore = getStore({
    name: "alerts",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const learningStore = getStore({
    name: "learnings",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });

  const [scan925, scan955] = await Promise.all([
    store.get("scan_925_latest", { type: "json" }),
    store.get("scan_955_latest", { type: "json" }),
  ]);

  const alertKeys = await listAlertJsonKeys(alertStore);
  const todaysAlerts = [];
  for (const key of alertKeys) {
    try {
      const alert = await alertStore.get(key, { type: "json" });
      if (alert && alert.timestamp && isSameNyDay(alert.timestamp)) {
        todaysAlerts.push(alert);
      }
    } catch {
      /* skip */
    }
  }

  const recentReviews = [];
  try {
    const eodKeys = [];
    for await (const page of learningStore.list({
      prefix: "eod_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        if (b.key && b.key !== "eod_latest") eodKeys.push(b.key);
      }
    }
    eodKeys.sort();
    for (const k of eodKeys.slice(-10)) {
      const review = await learningStore.get(k, { type: "json" });
      if (review) recentReviews.push(review);
    }
  } catch (e) {
    console.error("eod history", e);
  }

  const symSet = new Set(["SPY", "QQQ"]);
  for (const t of scan925?.watchlistBull || []) symSet.add(t.symbol);
  for (const t of scan925?.watchlistBear || []) symSet.add(t.symbol);
  for (const t of scan955?.confirmedTickers || []) symSet.add(t.symbol);
  for (const a of todaysAlerts) symSet.add(a.ticker);

  const allSyms = [...symSet].filter(Boolean);
  let quotes = {};
  if (allSyms.length) {
    const qd = await tradierGet("/v1/markets/quotes", {
      symbols: allSyms.join(","),
      greeks: "false",
    });
    for (const q of normList(qd.quotes?.quote)) {
      if (q.symbol) quotes[q.symbol] = q;
    }
  }

  const spyQ = quotes["SPY"];
  const qqqQ = quotes["QQQ"];
  const spyLast =
    spyQ != null
      ? parseFloat(spyQ.last ?? spyQ.close ?? 0)
      : 0;
  const spyDayChange = spyQ
    ? parseFloat(spyQ.change_percentage ?? spyQ.percent_change ?? 0)
    : 0;
  const qqqDayChange = qqqQ
    ? parseFloat(qqqQ.change_percentage ?? qqqQ.percent_change ?? 0)
    : 0;

  const results = todaysAlerts.map((alert) => {
    const ticker = alert.ticker;
    const q = quotes[ticker];
    const closePrice = parseFloat(q?.last ?? q?.close ?? 0);
    const priceAtAlert = parseFloat(
      alert.indicators?.price ?? alert.price ?? closePrice
    );
    const direction =
      String(alert.stage || "").includes("bear") ||
      /PUT|BEAR|fade/i.test(alert.setupType || "") ||
      (alert.option?.optType || "").toLowerCase() === "put"
        ? "bear"
        : "bull";
    let priceMove = 0;
    if (priceAtAlert > 0 && closePrice > 0) {
      priceMove = ((closePrice - priceAtAlert) / priceAtAlert) * 100;
    }
    let estimatedOptionReturn =
      direction === "bull" ? priceMove * 5 : -priceMove * 5;
    estimatedOptionReturn = Math.max(-100, Math.min(500, estimatedOptionReturn));

    let accuracy = "NEUTRAL";
    if (Math.abs(priceMove) > 0.5) {
      if (direction === "bull" && priceMove > 0.5) accuracy = "CORRECT";
      else if (direction === "bear" && priceMove < -0.5) accuracy = "CORRECT";
      else if (direction === "bull" && priceMove < -0.5) accuracy = "WRONG";
      else if (direction === "bear" && priceMove > 0.5) accuracy = "WRONG";
    }

    return {
      ticker,
      stage: alert.stage || "—",
      stageLabel: alert.stageLabel || alert.setupType,
      timeAlerted: alert.timestamp,
      priceAtAlert,
      priceAtClose: closePrice,
      priceMove,
      estimatedOptionReturn,
      accuracy,
      indicators: alert.indicators,
      aiSaidBuy:
        /bull|setup_bull/i.test(String(alert.stage || "")) ||
        /CALL|BULL/i.test(String(alert.setupType || "")),
      action: alert.stage?.action || alert.setupType,
      option: alert.option,
    };
  });

  const graded = results.filter((r) => r.accuracy !== "NEUTRAL");
  const correctCalls = graded.filter((r) => r.accuracy === "CORRECT").length;
  const wrongCalls = graded.filter((r) => r.accuracy === "WRONG").length;
  const totalCalls = graded.length;
  const winRate =
    totalCalls > 0 ? Math.round((correctCalls / totalCalls) * 100) : null;

  const historicalWinRates = recentReviews
    .filter((r) => r.winRate != null)
    .map((r) => r.winRate);
  const avgWinRate =
    historicalWinRates.length > 0
      ? Math.round(
          historicalWinRates.reduce((a, b) => a + b, 0) /
            historicalWinRates.length
        )
      : null;

  const model = process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  let eodAnalysis = "";
  let memEod = {
    insights: [],
    allTickerStats: [],
    allPatternStats: [],
    behavioralStats: null,
  };
  try {
    memEod = await getMemoryContext();
  } catch (e) {
    console.error("eod memory", e);
  }
  const eodContext = buildTradingContext(null, "SPY", spyLast, memEod);

  if (key) {
    const system = withSohelContext(
      `Market just closed. Review today honestly.
What worked, what didn't, and most 
importantly — what does Sohel need to 
do differently tomorrow?
Grade today: A/B/C/D.
Be direct. He needs the truth not 
a participation trophy.`,
      eodContext
    );
    const user = `Market closed. Performance review:

DATE: ${dateStr}
MARKET TODAY: SPY ${spyDayChange >= 0 ? "+" : ""}${spyDayChange.toFixed(2)}% | QQQ ${qqqDayChange >= 0 ? "+" : ""}${qqqDayChange.toFixed(2)}%

CALLS TODAY:
${results
  .map(
    (r) => `
${r.accuracy === "CORRECT" ? "✅" : r.accuracy === "WRONG" ? "❌" : "➖"} ${r.ticker} — ${r.stageLabel}
Price alert → close: $${r.priceAtAlert.toFixed(2)} → $${r.priceAtClose.toFixed(2)}
Stock move: ${r.priceMove >= 0 ? "+" : ""}${r.priceMove.toFixed(2)}% | Est option: ${r.estimatedOptionReturn >= 0 ? "+" : ""}${r.estimatedOptionReturn.toFixed(0)}%
`
  )
  .join("\n")}

TODAY: Correct ${correctCalls}/${totalCalls || "0"} (${winRate ?? "N/A"}%)
Neutral: ${results.filter((r) => r.accuracy === "NEUTRAL").length}

9:25 BULLS: ${scan925?.watchlistBull?.map((t) => t.symbol).join(", ") || "none"}
9:55 CONFIRMED: ${scan955?.confirmedTickers?.map((t) => t.symbol).join(", ") || "none"}

30-DAY AVG WIN: ${avgWinRate ?? "insufficient"}
RECENT EOD:
${recentReviews
  .slice(-5)
  .map(
    (r) =>
      `${r.date}: ${r.winRate ?? "N/A"}% (${r.correctCalls ?? 0}/${r.totalCalls ?? 0})`
  )
  .join("\n")}

INSTITUTIONAL LAYERS TODAY:
9:25 GEX (SPY): ${scan925?.gexSpy ? `${scan925.gexSpy.gexRegime} — ${String(scan925.gexSpy.interpretation || "").slice(0, 200)}` : "n/a"}
Per-alert master summaries: ${todaysAlerts
  .map((a) => (a.masterAnalysis?.summary ? `${a.ticker}: ${a.masterAnalysis.summary}` : ""))
  .filter(Boolean)
  .join(" | ") || "none"}

Give: assessment, per-wrong-call fix, per-correct-call what worked, pattern analysis, signal tweaks with thresholds, grade A–D, watch tomorrow. If Friday: weekend hold checklist per open symbol.
Also briefly: Was the GEX regime directionally useful? Did options-flow / sector bias from the morning match how names closed? Were key levels (if any in master summaries) respected?`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1500,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json();
    eodAnalysis = data.content?.[0]?.text || data.error?.message || "";
  }

  const eodData = {
    date: dateStr,
    timestamp: Date.now(),
    marketDay: { spyChange: spyDayChange, qqqChange: qqqDayChange },
    results,
    correctCalls,
    wrongCalls,
    totalCalls,
    winRate,
    avgWinRate30Day: avgWinRate,
    scan925Summary: scan925
      ? {
          called: scan925.watchlistBull?.map((t) => t.symbol) || [],
          sentiment: scan925.marketContext?.sentiment,
        }
      : null,
    scan955Summary: scan955
      ? {
          confirmed: scan955.confirmedTickers?.map((t) => t.symbol) || [],
          failed: scan955.failedTickers?.map((t) => t.symbol) || [],
        }
      : null,
    claudeAnalysis: eodAnalysis,
    model,
  };

  await learningStore.setJSON("eod_" + dateStr.replace(/\s/g, "_"), eodData);
  await learningStore.setJSON("eod_latest", eodData);

  const statsKey = "running_stats";
  let stats = (await learningStore.get(statsKey, { type: "json" })) || {
    totalDays: 0,
    totalCalls: 0,
    totalCorrect: 0,
    winRateHistory: [],
  };
  stats.totalDays = (stats.totalDays || 0) + 1;
  stats.totalCalls = (stats.totalCalls || 0) + totalCalls;
  stats.totalCorrect = (stats.totalCorrect || 0) + correctCalls;
  stats.winRateHistory = stats.winRateHistory || [];
  stats.winRateHistory.push({ date: dateStr, winRate });
  if (stats.winRateHistory.length > 60) stats.winRateHistory.shift();
  await learningStore.setJSON(statsKey, stats);

  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (bot && chat && eodAnalysis) {
    const gradeMatch = eodAnalysis.match(/Grade[:\s]+([A-D][+-]?)/i);
    const grade = gradeMatch ? gradeMatch[1] : "?";
    const gradeEmoji = grade.startsWith("A")
      ? "🏆"
      : grade.startsWith("B")
        ? "✅"
        : grade.startsWith("C")
          ? "⚠️"
          : "❌";
    const msg = `📊 <b>SOHELATOR EOD REVIEW — ${dateStr}</b>

${gradeEmoji} <b>TODAY'S GRADE: ${grade}</b>
Win rate: ${winRate ?? "N/A"}% (${correctCalls}/${totalCalls || 0} calls)
30-day avg: ${avgWinRate ?? "N/A"}%

<b>RESULTS:</b>
${results
  .map(
    (r) =>
      `${r.accuracy === "CORRECT" ? "✅" : r.accuracy === "WRONG" ? "❌" : "➖"} ${r.ticker}: ${r.priceMove >= 0 ? "+" : ""}${r.priceMove.toFixed(1)}% | Est opt: ${r.estimatedOptionReturn >= 0 ? "+" : ""}${r.estimatedOptionReturn.toFixed(0)}%`
  )
  .join("\n")}

<b>ANALYSIS:</b>
${eodAnalysis.slice(0, 800)}…

📈 <i>Full review in dashboard → SCAN tab</i>`;
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

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
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
    const learningStore = getStore({
      name: "learnings",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });
    const data = await learningStore.get("eod_latest", { type: "json" });
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(data || null),
    };
  }
  return runEod();
}

exports.handler = schedule("5 21 * * 1-5", httpHandler);
