const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const {
  getMemoryContext,
  getMemoryStore,
} = require("./lib/memory.cjs");
const {
  analyzePatterns,
  finalizePatterns,
  mergePatterns,
  getTopPatterns,
  getBottomPatterns,
  formatPatterns,
  generateImprovements,
} = require("./lib/eodPatterns");
const { recordJobOk, recordJobError } = require("./lib/jobHealth");
const { forecastSetup } = require("./lib/forecast");

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

/** Minutes since midnight in America/New_York (DST-aware). */
function minutesEtNow() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  let h = 0;
  let m = 0;
  for (const x of p) {
    if (x.type === "hour") h = +x.value;
    if (x.type === "minute") m = +x.value;
  }
  return h * 60 + m;
}

function dateStrUs() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function nySlashDate() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
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

/** YYYY-MM-DD in America/New_York (ET trading calendar). */
function ymdEt(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dt);
}

const POSITIONS_SESSION_LOG_KEY = "session-log";

async function loadSessionLogRowsForEtYmd(ymd) {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) return [];
  const posStore = getStore({
    name: "sohelator-positions",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  try {
    const log = await posStore.get(POSITIONS_SESSION_LOG_KEY, { type: "json" });
    if (!Array.isArray(log)) return [];
    return log.filter(
      (e) =>
        e &&
        typeof e.ts === "number" &&
        ymdEt(new Date(e.ts)) === ymd
    );
  } catch (e) {
    console.error("scan-eod session-log", e);
    return [];
  }
}

async function loadFullSessionLogForEod(posStore) {
  if (!posStore) return [];
  try {
    const log = await posStore.get(POSITIONS_SESSION_LOG_KEY, { type: "json" });
    return Array.isArray(log) ? log : [];
  } catch (e) {
    console.error("scan-eod full session-log", e);
    return [];
  }
}

/**
 * @param {any[]} log
 * @param {string} dateStr — ymdEt(new Date())
 */
function buildEodDebriefSummary(log, dateStr) {
  const totalPnlPct = log
    .filter((e) => e.outcome === "WIN" || e.outcome === "LOSS")
    .reduce((sum, e) => sum + (Number(e.pnlPct) || 0), 0);
  return {
    date: dateStr,
    totalAlertsFired: log.filter((e) => e.type === "ALERT_FIRED").length,
    totalPositionsOpened: log.filter((e) => e.type === "POSITION_OPENED").length,
    totalClosed: log.filter((e) => e.type === "POSITION_CLOSED").length,
    wins: log.filter((e) => e.outcome === "WIN").length,
    losses: log.filter((e) => e.outcome === "LOSS").length,
    totalPnlPct: totalPnlPct.toFixed(2),
    grokDecisions: log.filter((e) => e.type === "GROK_DECISION"),
    allPositions: log.filter(
      (e) => e.type === "POSITION_CLOSED" || e.type === "POSITION_OPENED"
    ),
  };
}

function parseGrokDebriefJson(text) {
  let s = String(text || "").trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const i = s.indexOf("{");
  const j = s.lastIndexOf("}");
  if (i < 0 || j <= i) return null;
  try {
    return JSON.parse(s.slice(i, j + 1));
  } catch {
    return null;
  }
}

function tuningLearningStore() {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) return null;
  return getStore({
    name: "sohelator-learning",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

/**
 * Merge non-null numeric fields from Grok into `optimized_params` blob.
 * @returns {Promise<{ changed: string[], diffs: { key: string, from: unknown, to: number }[], next: Record<string, unknown> | null }>}
 */
async function mergeOptimizedParamsFromGrokSuggestions(suggestions) {
  const store = tuningLearningStore();
  if (!store || !suggestions || typeof suggestions !== "object") {
    return { changed: [], diffs: [], next: null };
  }
  const keys = [
    "minScore",
    "adxThreshold",
    "volIgnition",
    "evThreshold",
    "alertCooldownHours",
    "gexThresholdPct",
  ];
  let cur = await store.get("optimized_params", { type: "json" });
  if (typeof cur === "string") {
    try {
      cur = JSON.parse(cur);
    } catch {
      cur = {};
    }
  }
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
  const next = { ...cur };
  const changed = [];
  const diffs = [];
  for (const k of keys) {
    const v = suggestions[k];
    if (v == null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const from = next[k];
    if (from !== n) {
      next[k] = n;
      changed.push(`${k} ${from}→${n}`);
      diffs.push({ key: k, from, to: n });
    }
  }
  if (changed.length) {
    await store.set("optimized_params", JSON.stringify(next), {
      metadata: { contentType: "application/json" },
    });
  }
  return { changed, diffs, next: changed.length ? next : null };
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
  /**
   * Netlify cron is UTC. Old schedule `0 19` = 3pm ET in summer — always skipped vs 4pm gate.
   * Allow ~4:00–5:35pm ET; cron uses `5 20,21 * * 1-5` (4:05pm / 5:05pm UTC slots → 4pm ET winter/summer).
   */
  const mt = minutesEtNow();
  if (mt < 16 * 60 || mt > 17 * 60 + 35) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        skipped: true,
        reason: "Outside EOD window (4:00–5:35pm ET)",
      }),
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

  try {
    const existing = await learningStore.get("eod_latest", { type: "json" });
    if (existing && existing.date === dateStr) {
      return {
        statusCode: 200,
        body: JSON.stringify({
          skipped: true,
          reason: "EOD already completed for this session",
        }),
      };
    }
  } catch {
    /* continue */
  }

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

  let memStore = null;
  let validSnaps = [];
  try {
    memStore = getMemoryStore();
    const dateStrKey = nySlashDate().replace(/\//g, "_");
    const todayKeys =
      (await memStore.get(`snapshots_${dateStrKey}`, { type: "json" })) || [];
    const idList = Array.isArray(todayKeys) ? todayKeys : [];
    const snapshots = await Promise.all(
      idList.map((id) => memStore.get(`snapshot_${id}`, { type: "json" }))
    );
    validSnaps = snapshots.filter(Boolean);
  } catch (e) {
    console.error("eod snapshots load", e);
  }

  let priorPatterns = null;
  try {
    const ms = memStore || getMemoryStore();
    priorPatterns = await ms.get("patterns_all_time", { type: "json" });
  } catch (e) {
    console.error("eod prior patterns", e);
  }

  const symSet = new Set(["SPY", "QQQ"]);
  for (const t of scan925?.watchlistBull || []) symSet.add(t.symbol);
  for (const t of scan925?.watchlistBear || []) symSet.add(t.symbol);
  for (const t of scan955?.confirmedTickers || []) symSet.add(t.symbol);
  for (const a of todaysAlerts) symSet.add(a.ticker);
  for (const s of validSnaps) symSet.add(s.ticker);

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

  if (memStore && validSnaps.length) {
    for (const snap of validSnaps) {
      const quote = quotes[snap.ticker];
      if (!quote) continue;
      const closePrice = parseFloat(quote.last ?? quote.close ?? 0);
      if (!closePrice) continue;
      const alertPrice = snap.prediction?.optionPremium;
      const stockAtAlert =
        snap.indicators?.priceAtAlert != null
          ? Number(snap.indicators.priceAtAlert)
          : closePrice;
      const stockMovePct =
        stockAtAlert > 0
          ? ((closePrice - stockAtAlert) / stockAtAlert) * 100
          : 0;
      const directionCorrect =
        (snap.prediction.direction === "BULL" && stockMovePct > 0.3) ||
        (snap.prediction.direction === "BEAR" && stockMovePct < -0.3);
      const nr = snap.levels?.nearestResistance;
      const ns = snap.levels?.nearestSupport;
      let hitTarget = null;
      if (snap.prediction.direction === "BULL" && nr != null) {
        hitTarget = closePrice >= nr * 0.995;
      } else if (snap.prediction.direction === "BEAR" && ns != null) {
        hitTarget = closePrice <= ns * 1.005;
      }
      const estOptionReturn =
        alertPrice > 0 ? stockMovePct * 0.45 * 2 : 0;

      let priorForecast = null;
      try {
        if (priorPatterns) {
          priorForecast = await forecastSetup(snap, priorPatterns);
        }
      } catch (e) {
        console.error("eod forecastSetup", snap.id, e);
      }
      const fc = priorForecast?.forecastWinRate;
      snap.outcome = {
        filled: true,
        priceAtClose: closePrice,
        premiumAtClose: null,
        stockMovePct: +stockMovePct.toFixed(2),
        estimatedOptionReturn: +estOptionReturn.toFixed(1),
        hitTarget,
        correct: directionCorrect,
        exitReason: "EOD",
        holdMinutes: (Date.now() - snap.timestamp) / 60000,
        priorPatternForecastWinRate:
          fc != null ? fc : null,
        priorForecastConfidence: priorForecast?.forecastConfidence ?? null,
        forecastVsOutcome:
          fc != null && directionCorrect != null
            ? (fc >= 50) === !!directionCorrect
            : null,
      };
      try {
        await memStore.setJSON(`snapshot_${snap.id}`, snap);
      } catch (e) {
        console.error("snapshot save", snap.id, e);
      }
    }
  }

  let patternsToday = null;
  let allTimePatternsMerged = null;
  let topPatterns = [];
  let bottomPatterns = [];
  let improvementSuggestions = [];
  let totalDaysLearning = 0;

  if (memStore && validSnaps.length) {
    try {
      const rawPatterns = analyzePatterns(validSnaps);
      patternsToday = finalizePatterns(rawPatterns, validSnaps);
      const dateKeyPat = nySlashDate().replace(/\//g, "_");
      await memStore.setJSON(`patterns_${dateKeyPat}`, patternsToday);
      const prevAll = (await memStore.get("patterns_all_time", {
        type: "json",
      })) || {};
      allTimePatternsMerged = mergePatterns(prevAll, patternsToday);
      await memStore.setJSON("patterns_all_time", allTimePatternsMerged);
      topPatterns = getTopPatterns(allTimePatternsMerged, 5, 8);
      bottomPatterns = getBottomPatterns(allTimePatternsMerged, 5, 8);
      const rs = await learningStore.get("running_stats", { type: "json" });
      totalDaysLearning = rs?.totalDays ?? 0;
      improvementSuggestions = generateImprovements(
        patternsToday,
        allTimePatternsMerged,
        totalDaysLearning
      );
      await learningStore.setJSON("latest_improvements", {
        date: dateStr,
        suggestions: improvementSuggestions,
        updatedAt: Date.now(),
      });
    } catch (e) {
      console.error("eod patterns", e);
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

SNAPSHOTS GRADED TODAY: ${validSnaps.length} (signal memory store)

TODAY'S PATTERN ANALYSIS:
${formatPatterns(patternsToday || {})}

ALL-TIME PATTERNS (${totalDaysLearning || "N/A"} trading days in running stats):
${formatPatterns(allTimePatternsMerged || {})}

TOP PERFORMING CONDITIONS (all time):
${
  topPatterns.length
    ? topPatterns
        .map(
          (p) =>
            `• ${p.name}: ${p.winRate}% win rate (${p.count} signals)`
        )
        .join("\n")
    : "(not enough bucketed data yet)"
}

WORST PERFORMING CONDITIONS (all time):
${
  bottomPatterns.length
    ? bottomPatterns
        .map(
          (p) =>
            `• ${p.name}: ${p.winRate}% win rate (${p.count} signals) — consider filtering`
        )
        .join("\n")
    : "(not enough bucketed data yet)"
}

SYSTEM IMPROVEMENT ANALYSIS:
Based on ${totalDaysLearning || "N/A"} days of real data:

${
  improvementSuggestions.length
    ? improvementSuggestions
        .map(
          (s) =>
            `[${s.impact} IMPACT] ${s.component}:
  Current: ${s.current}
  Suggested: ${s.suggested}
  Why: ${s.reason}
  Data: ${s.dataPoints} signals analyzed`
        )
        .join("\n\n")
    : "(no automated suggestions yet — need more snapshot outcomes)"
}

For each suggestion:
1. Do you agree based on the data?
2. What would be the trade-off?
3. Any other improvements you'd suggest based on what you're seeing?
4. What additional data would help you make better predictions?
5. If you could add one new indicator or data source what would it be and why?

Based on this real performance data:
1. What patterns are genuinely predictive?
2. What signals should we filter out?
3. What thresholds should we adjust?
4. What new data would improve accuracy?
5. Grade today's signal quality A-F

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
        max_tokens: 2200,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json();
    eodAnalysis = data.content?.[0]?.text || data.error?.message || "";
  }

  let eodDebriefSummary = null;
  let grokDebriefRaw = "";
  let grokDebriefParsed = null;
  let paramTuneChanged = [];
  let parameterMergeDiff = [];
  try {
    const ymdKey = ymdEt(new Date());
    const sessionRows = await loadSessionLogRowsForEtYmd(ymdKey);
    eodDebriefSummary = buildEodDebriefSummary(sessionRows, ymdKey);
    if (process.env.ANTHROPIC_API_KEY) {
      const { callClaudeExpensive } = await import("../../src/lib/claude.js");
      const summaryJson = JSON.stringify(eodDebriefSummary, null, 2);
      const debriefPrompt = `You are SOHELATOR's head analyst. Run the end-of-day debrief and make the scan co-pilot smarter for tomorrow.

Today's session log:
${summaryJson}

Respond ONLY with valid JSON in exactly this structure:
{
  "performanceReview": "3-4 sentences on what happened today",
  "cheapGrokAudit": "review every CLOSE/ADD/HOLD decision — score right or wrong based on outcome, identify patterns",
  "filterAssessment": "were scanner filters catching good setups or noise? be specific",
  "tomorrowInstructions": "direct instruction set for the AI co-pilot to follow tomorrow — what to favor, avoid, watch for.",
  "parameterSuggestions": { "minScore": null, "adxThreshold": null, "volIgnition": null, "evThreshold": null, "alertCooldownHours": null, "gexThresholdPct": null },
  "sessionGrade": "A or B or C or D or F",
  "keyLearning": "one sentence max"
}`;
      grokDebriefRaw = await callClaudeExpensive(debriefPrompt, 2500);
      grokDebriefParsed = parseGrokDebriefJson(grokDebriefRaw);

      const tuningStore = tuningLearningStore();
      if (tuningStore && grokDebriefParsed && typeof grokDebriefParsed === "object") {
        const merge = await mergeOptimizedParamsFromGrokSuggestions(
          grokDebriefParsed.parameterSuggestions
        );
        paramTuneChanged = merge.changed;
        parameterMergeDiff = merge.diffs || [];
        const blobPayload = {
          ...grokDebriefParsed,
          summary: eodDebriefSummary,
          savedAt: Date.now(),
          savedAtIso: new Date().toISOString(),
          paramTuneChanged,
          parameterMergeDiff,
        };
        await tuningStore.setJSON(`learning-${ymdKey}`, blobPayload);
      }
    }
  } catch (e) {
    console.error("scan-eod debrief block", e);
  }

  let comprehensiveEodReview = "";
  let comprehensiveEodParsed = null;
  try {
    if (
      process.env.ANTHROPIC_API_KEY &&
      process.env.NETLIFY_SITE_ID &&
      process.env.NETLIFY_TOKEN
    ) {
      const { callClaudeExpensive } = await import("../../src/lib/claude.js");
      const posStore = getStore({
        name: "sohelator-positions",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_TOKEN,
      });
      const fullLog = await loadFullSessionLogForEod(posStore);
      const ymdKey2 = ymdEt(new Date());
      const todayLog = fullLog.filter(
        (e) => e && e.tsIso && e.tsIso.startsWith(ymdKey2)
      );
      const sessionSummary = {
        date: ymdKey2,
        alertsFired: todayLog.filter((e) => e.type === "ALERT_FIRED").length,
        positionsOpened: todayLog.filter((e) => e.type === "POSITION_OPENED")
          .length,
        positionsClosed: todayLog.filter((e) => e.type === "POSITION_CLOSED")
          .length,
        grokDecisions: todayLog.filter((e) => e.type === "GROK_DECISION"),
        wins: todayLog.filter((e) => e.outcome === "WIN").length,
        losses: todayLog.filter((e) => e.outcome === "LOSS").length,
        totalPnlPct: todayLog
          .filter((e) => e.outcome === "WIN" || e.outcome === "LOSS")
          .reduce((sum, e) => sum + (Number(e.pnlPct) || 0), 0)
          .toFixed(2),
        checkpoints: todayLog.filter((e) => e.type === "CHECKPOINT"),
        newsFlags: todayLog.filter((e) => e.type === "NEWS_FLAG"),
      };
      let matrixSignalLatest = null;
      let marketProbLastBias = null;
      try {
        matrixSignalLatest = await posStore.get("matrix-signal-latest", {
          type: "json",
        });
      } catch (_) {
        /* ignore */
      }
      try {
        marketProbLastBias = await posStore.get("market-prob-last-bias", {
          type: "json",
        });
      } catch (_) {
        /* ignore */
      }
      const matrixCtx = {
        snapshot: matrixSignalLatest,
        lastBias: marketProbLastBias,
      };
      const eodPrompt = `You are SOHELATOR's end-of-day analyst. Review today's trading session and provide actionable improvements.

Today's session data:
${JSON.stringify(sessionSummary, null, 2)}

Matrix / bias snapshot (what the system saw):
${JSON.stringify(matrixCtx, null, 2)}

Your job is to review five things and be completely honest:

1. WHAT WORKED TODAY — which alerts, signals, or decisions were correct and why
2. WHAT FAILED TODAY — which signals were wrong, which alerts were noise, any false signals
3. ALERT QUALITY — were the Telegram alerts useful or were they spam? Too many? Too few? Wrong timing?
4. SIGNAL ACCURACY — did the matrix graduation signal match what actually happened in the market?
5. TOMORROW'S PRIORITIES — what specific things should the system focus on tomorrow? Any adjustments needed?

Be direct. Be specific. Use plain English. No jargon.

End your response with exactly this JSON block (no markdown fences):
{
  "sessionGrade": "A or B or C or D or F",
  "keyLearning": "one sentence",
  "alertQuality": "good or noisy or missed",
  "signalAccuracy": "accurate or mixed or off",
  "tomorrowFocus": "one specific thing to watch tomorrow",
  "paramSuggestions": {
    "minScore": null,
    "alertCooldownHours": null,
    "gexThresholdPct": null
  }
}`;

      comprehensiveEodReview = await callClaudeExpensive(eodPrompt, 2000);
      const jsonM = comprehensiveEodReview.match(/\{[\s\S]*\}/);
      let parsedComp = {};
      if (jsonM) {
        try {
          parsedComp = JSON.parse(jsonM[0]);
        } catch (_) {
          parsedComp = {};
        }
      }
      comprehensiveEodParsed = parsedComp;

      const tuningStoreEod = tuningLearningStore();
      if (tuningStoreEod && parsedComp.paramSuggestions && typeof parsedComp.paramSuggestions === "object") {
        const mergeEod = await mergeOptimizedParamsFromGrokSuggestions(
          parsedComp.paramSuggestions
        );
        if (mergeEod.changed && mergeEod.changed.length) {
          paramTuneChanged = [
            ...new Set([...(paramTuneChanged || []), ...mergeEod.changed]),
          ];
        }
      }

      if (tuningStoreEod) {
        await tuningStoreEod.setJSON(`eod-review-${ymdKey2}`, {
          fullText: comprehensiveEodReview,
          parsed: parsedComp,
          sessionSummary,
          matrixSignalLatest,
          marketProbLastBias,
          savedAt: Date.now(),
          savedAtIso: new Date().toISOString(),
        });
      }

      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_CHAT_ID;
      if (bot && chat && comprehensiveEodReview) {
        const reviewText = comprehensiveEodReview.split("{")[0].trim();
        const parsed = parsedComp;
        const g0 = String(parsed.sessionGrade || "").trim().charAt(0).toUpperCase();
        const gradeEmoji =
          { A: "🏆", B: "✅", C: "⚠️", D: "❌", F: "💀" }[g0] || "📊";
        const msg = [
          `${gradeEmoji} SOHELATOR EOD REVIEW — ${ymdKey2}`,
          `Grade: ${parsed.sessionGrade || "—"}`,
          ``,
          reviewText.slice(0, 800),
          ``,
          `📌 Key learning: ${parsed.keyLearning || "—"}`,
          `🎯 Tomorrow: ${parsed.tomorrowFocus || "—"}`,
          ``,
          `Alerts today: ${sessionSummary.alertsFired} | Positions: ${sessionSummary.positionsOpened} | W/L: ${sessionSummary.wins}/${sessionSummary.losses}`,
          `Session P&L: ${sessionSummary.totalPnlPct}%`,
        ]
          .join("\n")
          .slice(0, 4000);
        await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chat,
            text: msg,
            disable_web_page_preview: true,
          }),
        }).catch((e) => console.warn("EOD review Telegram:", e?.message));
      }
    }
  } catch (e) {
    console.error("scan-eod comprehensive Claude review", e);
  }

  const gradeMatchEod = eodAnalysis.match(/Grade[:\s]+([A-F][+-]?)/i);
  let gradeLetter = gradeMatchEod ? gradeMatchEod[1] : null;
  if (
    !gradeLetter &&
    winRate != null &&
    totalCalls > 0
  ) {
    if (winRate >= 70) gradeLetter = "A";
    else if (winRate >= 55) gradeLetter = "B";
    else if (winRate >= 40) gradeLetter = "C";
    else gradeLetter = "D";
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
    snapshotCount: validSnaps.length,
    patternsToday: patternsToday || null,
    patternsAllTime: allTimePatternsMerged || null,
    topPatterns,
    bottomPatterns,
    improvementSuggestions,
    gradeLetter,
    eodDebriefSummary,
    grokDebriefRaw,
    grokDebriefParsed,
    paramTuneChanged,
    parameterMergeDiff,
    comprehensiveEodReview,
    comprehensiveEodParsed,
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

  try {
    await recordJobOk("scan-eod", {
      timestamp: eodData.timestamp,
      winRate: eodData.winRate,
      gradeLetter: eodData.gradeLetter,
    });
  } catch (e) {
    console.error("recordJobOk scan-eod", e);
  }

  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (bot && chat) {
    if (grokDebriefParsed && eodDebriefSummary) {
      const sg = eodDebriefSummary;
      const gd = grokDebriefParsed;
      const sessionGrade = String(gd.sessionGrade || "?").trim();
      const keyLearning = String(gd.keyLearning || "—").trim();
      const audit120 = String(gd.cheapGrokAudit || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      const tom100 = String(gd.tomorrowInstructions || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 100);
      const sug = gd.parameterSuggestions || {};
      const nonNullParams = ["minScore", "adxThreshold", "volIgnition", "evThreshold"]
        .filter((k) => sug[k] != null && sug[k] !== "")
        .map((k) => `${k}=${sug[k]}`);
      const paramsLine =
        paramTuneChanged.length > 0
          ? paramTuneChanged.join(", ")
          : nonNullParams.length > 0
            ? nonNullParams.join(", ")
            : "no changes";
      const debriefMsg = `📊 EOD DEBRIEF — ${sg.date}
Grade: ${sessionGrade}
${sg.wins}W · ${sg.losses}L · P&L ${sg.totalPnlPct}%
${keyLearning}
Cheap Grok audit: ${audit120 || "—"}
Tomorrow: ${tom100 || "—"}
Params updated: ${paramsLine}`;
      fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: debriefMsg.slice(0, 3900),
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const t = await r.text().catch(() => "");
            console.error("scan-eod Telegram debrief http", r.status, t.slice(0, 200));
          }
        })
        .catch((e) => console.error("scan-eod Telegram debrief", e?.message || e));
    }
    if (eodAnalysis) {
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
      fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: msg,
          parse_mode: "HTML",
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const t = await r.text().catch(() => "");
            console.error("scan-eod Telegram EOD review http", r.status, t.slice(0, 200));
          }
        })
        .catch((e) => console.error("scan-eod Telegram EOD review", e?.message || e));
    }
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
  return runEod().catch(async (e) => {
    console.error(e);
    await recordJobError("scan-eod", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  });
}

exports.handler = schedule("5 20,21 * * 1-5", httpHandler);
