/**
 * SOHELATOR blueprint — live scanner: liquid universe → multi-TF data → scored setups
 * → historical similarity → rich dashboard alerts (+ optional driving string).
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12):
 * POST body may include extraSymbols, prioritySymbols, catalystNewsSummary (from cheap-monitor news pass).
 * SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19):
 * score ≥65 → formatted message; optional suppressTelegram when cheap-monitor relays the same run.
 */

import {
  getLiquidOptionsWatchlist,
  getTimesales,
  getQuote,
  getDailyHistory,
  suggestAtmOption,
} from "../../src/lib/tradier.js";
import {
  calculateSetupScore,
  applyOptimizedParams,
  getOptimizedParams,
} from "../../src/lib/scanner-rules.js";
import {
  runBacktest,
  findSimilarSetups,
  SIMILAR_SETUPS_MAX_RESULTS,
} from "../../src/lib/backtester.js";
import { formatDrivingAlert } from "../../src/lib/alert-formatter.js";
import { num } from "../../src/lib/utils.js";
import {
  callClaudeCheap,
  callClaudeWithFallback,
} from "../../src/lib/claude.js";
import { getStore } from "./lib/blobsStore.cjs";
import { prepareAlertsForRelay } from "./lib/alertQuality.cjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

/** In-process dedupe for Telegram sends (serverless instance lifetime). */
const SESSION_DEDUPE = new Map();
const SYMBOL_TELEGRAM_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const VOLUME_TELEGRAM_COOLDOWN_MS = 3 * 60 * 60 * 1000;

/** Persists latest POST /api/scan JSON for HUD GET /api/scan-data (cheap-monitor updates without opening the app). */
async function persistLastHudScan(payload) {
  try {
    const scannerStore = getStore('scanner');
    await scannerStore.setJSON("last_hud_scan", payload);
  } catch (e) {
    console.warn("scan.js persist last_hud_scan", e?.message || e);
  }
}

const DEFAULT_UNIVERSE = [
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
];

function priceBucket(last, mode) {
  return true;
}

/** Same regime labels as backtester (blueprint). */
function classifyPlayType(rScalp, rSwing) {
  const absS = Math.abs(rScalp);
  const absW = Math.abs(rSwing);
  if (absS >= absW * 0.85 && Math.sign(rScalp) === Math.sign(rSwing || rScalp))
    return "SCALP";
  if (absW > absS * 1.1) return "SWING";
  return "SCALP_SWING";
}

/** Live label from recent path vs horizons (no future bars). */
function livePlayTypeFromBars(bars5, scalpH, swingH, riskPct) {
  if (!bars5?.length) return "SCALP_SWING";
  const i = bars5.length - 1;
  const bull = num(bars5[i].close) >= num(bars5[i].open ?? bars5[i].close);
  const entry = num(bars5[i].close);
  const risk = entry * (riskPct / 100);
  if (!risk) return "SCALP_SWING";
  const iS = Math.max(0, i - scalpH);
  const iW = Math.max(0, i - swingH);
  const pastScalp = entry - num(bars5[iS].close);
  const pastSwing = entry - num(bars5[iW].close);
  const rScalp = bull ? pastScalp / risk : -pastScalp / risk;
  const rSwing = bull ? pastSwing / risk : -pastSwing / risk;
  return classifyPlayType(rScalp, rSwing);
}

function playLabelPretty(pt) {
  if (pt === "SCALP_SWING") return "SCALP→SWING";
  return pt;
}

function levelsFromLastBar(bars5, bull, riskPct) {
  const last = bars5[bars5.length - 1];
  const entry = num(last.close);
  const risk = entry * (riskPct / 100);
  if (bull) {
    return {
      entry,
      stop: entry - 2 * risk,
      target: entry + 3 * risk,
    };
  }
  return {
    entry,
    stop: entry + 2 * risk,
    target: entry - 3 * risk,
  };
}

/**
 * Entry/stop/target are from the last 5m bar close; `last` is the live quote.
 * Without this check we repeatedly alert after price has already hit stop/target
 * or left the entry zone — looks "wrong" in Telegram/HUD.
 */
function isSetupLiveActionable(setup) {
  const live = Number(setup.last ?? setup.underlyingAtAlert);
  const stop = Number(setup.stop);
  const target = Number(setup.target);
  const entry = Number(setup.entry);
  if (!Number.isFinite(live) || live <= 0) return true;
  if (
    !Number.isFinite(entry) ||
    !Number.isFinite(stop) ||
    !Number.isFinite(target)
  ) {
    return true;
  }
  const eps = Math.max(entry * 0.001, 0.02);
  const isLong = String(setup.direction || "").toLowerCase() !== "short";
  if (isLong) {
    if (live <= stop + eps) return false;
    if (live >= target - eps) return false;
  } else {
    if (live >= stop - eps) return false;
    if (live <= target + eps) return false;
  }
  return true;
}

function historicalSummary(similar) {
  const n = Array.isArray(similar) ? similar.length : 0;
  if (!n) return "Historical: no close matches in last backtest cache.";
  const wins = similar.filter((s) => s.win).length;
  const wr = Math.round((wins / n) * 100);
  const top = similar[0];
  return `Historical: ${n} near matches, ~${wr}% wins in sample. Closest: ${top.symbol} (${playLabelPretty(top.playType)}, sim=${top.similarity}). ${top.patternNote || ""}`;
}

/** Prompt 8 — America/New_York 8:00–16:00 weekdays for Grok / expensive alignment */
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

function isWeekdayEt(d) {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
  return w !== "Sat" && w !== "Sun";
}

function isEtGrokWindow(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= 8 * 60 && t <= 16 * 60;
}

/** US equity options generally trade ~9:30–16:00 ET Mon–Fri — skip actionable alerts outside. */
function isUsEquityOptionsRthEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  return t >= open && t < close;
}


function volRatioOfAlert(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function sustainedVolRatioOfAlert(a) {
  const s = Number(a?.details?.sustainedVolRatio);
  return Number.isFinite(s) ? s : volRatioOfAlert(a);
}

function hasCatalystSignal(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST/i.test(
    s
  );
}

function hasRegimeOrLevelKeywords(a) {
  const v = (
    String(a?.aiVerdict || "") +
    " " +
    String(a?.aiCoPilot || "")
  ).toUpperCase();
  return /REVERSAL|REGIME|PIVOT|KEY LEVEL|BREAKDOWN|BREAKOUT|SWEEP|STOP\s*RUN|VWAP/.test(v);
}

function historicalMatchesShort(a) {
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

/**
 * SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19)
 * Clean format + optional high-signal banner lines (90+, vol, catalyst, regime/levels).
 */
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
  const opt = a.suggestedOption
    ? `Option: ${a.suggestedOption.description || JSON.stringify(a.suggestedOption)}`
    : "";

  let analysis = String(a.grokAnalysis || "").replace(/\s+/g, " ").trim();
  let risks = String(a.grokRisks || "").replace(/\s+/g, " ").trim();
  let plan = String(a.grokPlan || a.plan || "")
    .replace(/\s+/g, " ")
    .trim();
  let verdict = String(a.aiVerdict || "").replace(/\s+/g, " ").trim();
  if (analysis.length > 300) analysis = analysis.slice(0, 297) + "…";
  if (risks.length > 150) risks = risks.slice(0, 147) + "…";
  if (plan.length > 150) plan = plan.slice(0, 147) + "…";
  if (verdict.length > 150) verdict = verdict.slice(0, 147) + "…";

  const histLine = historicalMatchesShort(a);

  const hi = [];
  const svr = sustainedVolRatioOfAlert(a);
  const pm = a?.details?.priceMoving === true;
  if (score >= 90) hi.push("⚡ SCORE 90+ — TOP TIER");
  if (Number.isFinite(svr) && svr >= 2.5 && pm) {
    hi.push("⚡ VOL SURGE " + svr.toFixed(1) + "x");
  }
  if (hasCatalystSignal(a)) hi.push("⚡ CATALYST / NEWS");
  if (hasRegimeOrLevelKeywords(a)) hi.push("⚡ REGIME / LEVEL / REVERSAL");
  const banner = hi.length ? hi.join("\n") + "\n\n" : "";

  const header = [
    `📡 SCANNER ALERT — ${sym}`,
    `Source: Rules scan + Claude analysis`,
    `━━━━━━━━━━━━━━━━━━━━━`,
  ].join("\n");

  return (
    header +
    "\n\n" +
    banner +
    `${sym} - ${play}\n` +
    `SCORE ${score} | EDGE ${edgeStr}\n` +
    `Price: ${priceStr}${chg}\n` +
    `Play: ENTRY @ ${entryStr}\n` +
    `Stop: ${stopStr} | Target: ${tgtStr}\n` +
    `${opt ? opt + "\n" : ""}` +
    `Analysis: ${analysis || "—"}\n` +
    `Risks: ${risks || "—"}\n` +
    `Plan: ${plan || "—"}\n` +
    `Verdict: ${verdict || "—"}\n` +
    `Historical: ${histLine}`
  );
}

async function sendTelegramScanAlert(lines) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  const text = String(lines || "").trim().slice(0, 3900);
  if (!text) return;
  try {
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.warn("scan.js Telegram:", e?.message || e);
  }
}

const GROK_HEALTH_RANK = {
  error: 5,
  fallback_cheap: 4,
  ok: 3,
  outside_window: 2,
  skipped: 1,
};

function worseGrokHealth(a, b) {
  return (GROK_HEALTH_RANK[b] || 0) > (GROK_HEALTH_RANK[a] || 0) ? b : a;
}

const PHASE1_MS = 8000;
const FUNCTION_TIMEOUT_MS = 25000;
const CLAUDE_PER_TICKER_MS = 15000;
/** Rules-only phase: minimum score to include in alerts (Claude sees top 3 of these). */
const RULES_SCORE_MIN = 80;

/**
 * Race Claude call against wall clock — avoids Netlify 502 when API hangs.
 * @param {() => Promise<string>} fn
 * @param {number} timeoutMs
 */
async function callClaudeWithTimeout(fn, timeoutMs) {
  return Promise.race([
    fn(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`Claude timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    ),
  ]);
}

/** Parse per-ticker Claude reply with ANALYSIS:/RISKS:/PLAN:/VERDICT: labels. */
function parseSectionedClaude(text) {
  const s = String(text || "");
  const grab = (name) => {
    const re = new RegExp(
      `(?:^|\\n)\\s*${name}\\s*:\\s*([\\s\\S]*?)(?=\\n\\s*(?:ANALYSIS|RISKS|PLAN|VERDICT)\\s*:|$)`,
      "i"
    );
    const m = s.match(re);
    return m ? m[1].trim().replace(/\s+/g, " ") : "";
  };
  return {
    analysis: grab("ANALYSIS"),
    risks: grab("RISKS"),
    plan: grab("PLAN"),
    verdict: grab("VERDICT"),
  };
}

/**
 * Phase 1 — rules only (Tradier + scoring + levels + options). No Claude.
 * Wrapped by caller with an 8s wall clock; on internal error returns empty alerts.
 */
async function runPhase1RulesScan({ scanMode, mergedUniverse, prioritySyms }) {
  try {
    let backtest7 = null;
    try {
      backtest7 = await Promise.race([
        runBacktest(7),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("backtest_timeout")), 2500)
        ),
      ]);
    } catch {
      backtest7 = null;
    }

    const liquid = await getLiquidOptionsWatchlist(mergedUniverse);
    const withQuotes = await Promise.all(
      liquid.map(async (symbol) => {
        const q = await getQuote(symbol);
        const last = parseFloat(q?.last ?? q?.bid ?? 0) || 0;
        return { symbol, last, q };
      })
    );

    const filtered = withQuotes.filter((x) => priceBucket(x.last, scanMode));
    const sortedFiltered = filtered.slice().sort((a, b) => {
      const pa = prioritySyms.has(a.symbol) ? 0 : 1;
      const pb = prioritySyms.has(b.symbol) ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return (Number(b.last) || 0) - (Number(a.last) || 0);
    });
    const take =
      scanMode === "expensive"
        ? sortedFiltered.slice(0, 4)
        : sortedFiltered.slice(0, 5);

    const P = getOptimizedParams();
    const scalpH = Math.max(3, Math.round(num(P.scalpHorizonBars, 6)));
    const swingH = Math.max(
      scalpH + 1,
      Math.round(num(P.swingHorizonBars, 48))
    );
    const riskPct = num(P.riskPctPerR, 0.25);

    const alerts = [];

    for (const row of take) {
      const symbol = row.symbol;
      const [bars5, bars15, daily] = await Promise.all([
        getTimesales(symbol, "5min", 5),
        getTimesales(symbol, "15min", 5),
        getDailyHistory(symbol, 120),
      ]);

      if (!bars5.length || bars5.length < 10) continue;

      const sc = await calculateSetupScore(bars5, symbol, daily);
      if (sc.score < RULES_SCORE_MIN) continue;

      const similar = await findSimilarSetups(
        { symbol, bars: bars5, dailyBars: daily },
        SIMILAR_SETUPS_MAX_RESULTS
      );

      const bull =
        num(bars5[bars5.length - 1].close) >=
        num(bars5[bars5.length - 1].open);
      const playRaw = livePlayTypeFromBars(bars5, scalpH, swingH, riskPct);
      const playTypeLabel = playLabelPretty(playRaw);
      const lv = levelsFromLastBar(bars5, bull, riskPct);
      const hist = historicalSummary(similar);
      const bPrev = bars5[bars5.length - 2];
      const bLast = bars5[bars5.length - 1];
      const cPrev = bPrev ? num(bPrev.close) : 0;
      const cLast = bLast ? num(bLast.close) : 0;
      const barChgPct =
        cPrev > 0 ? ((cLast - cPrev) / cPrev) * 100 : null;

      const tAlert = Date.now();
      const setup = {
        symbol,
        score: sc.score,
        edge: sc.edge,
        playType: playRaw,
        playTypeLabel,
        direction: bull ? "long" : "short",
        last: row.last,
        alertedAt: tAlert,
        alertedAtIso: new Date(tAlert).toISOString(),
        underlyingAtAlert: row.last,
        barChgPct,
        bars5m: bars5.length,
        bars15m: bars15.length,
        dailyBars: daily.length,
        entry: lv.entry,
        stop: lv.stop,
        target: lv.target,
        aiVerdict:
          sc.details.passesEv
            ? "Rules edge: passes EV threshold — confirm with tape / spread before size."
            : "Rules edge below EV floor — paper / skip.",
        historicalSummary: hist,
        similarCount: similar.length,
        ev: sc.edge,
        projectedEv: backtest7?.ev ?? null,
        thetaCountdown: undefined,
        similar,
        details: sc.details,
      };

      if (!isSetupLiveActionable(setup)) continue;

      try {
        const sug = await suggestAtmOption(symbol, row.last, bull);
        if (sug) {
          setup.suggestedOption = sug;
          const right = sug.right === "call" ? "CALL" : "PUT";
          const exp = sug.expiration || "—";
          const strike = sug.strike || "—";
          const mid = Number.isFinite(Number(sug.mid))
            ? `$${Number(sug.mid).toFixed(2)}`
            : "—";
          const delta = Number.isFinite(Number(sug.delta))
            ? Number(sug.delta).toFixed(2)
            : "—";
          setup.suggestedOption.description = `${strike}${right} exp ${exp} | Mid ${mid} | Δ ${delta}`;
        }
      } catch (e) {
        console.warn("scan suggestAtmOption", symbol, e?.message || e);
      }

      setup.drivingText = formatDrivingAlert(setup);
      alerts.push(setup);
    }

    alerts.sort((a, b) => (b.score || 0) - (a.score || 0));
    return { alerts, backtest7, P };
  } catch (e) {
    console.error("scan.js runPhase1RulesScan:", e?.message || e);
    return { alerts: [], backtest7: null, P: getOptimizedParams() };
  }
}

/** Phase 2 — Claude enrichment for a single setup (15s cap). */
async function enrichTopTickerWithClaude(setup, scanMode) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const ticker = String(setup.symbol || "").toUpperCase();
  const score = Number(setup.score) || 0;
  const direction = String(setup.direction || "");
  const entry = Number(setup.entry);
  const stop = Number(setup.stop);
  const target = Number(setup.target);
  const priceChangePct =
    setup.barChgPct != null && Number.isFinite(Number(setup.barChgPct))
      ? Number(setup.barChgPct).toFixed(2)
      : "—";
  const volumeRatio = num(setup.details?.volRatio, 1).toFixed(2);
  const rsi = num(setup.details?.rsi, NaN);
  const emaDistPct = Number.isFinite(rsi)
    ? (((rsi - 50) / 50) * 100).toFixed(1)
    : "—";

  const claudePrompt = `You are a trading analyst. Analyze this setup in 3 short sections.

Ticker: ${ticker}
Score: ${score}
Direction: ${direction}
Entry: ${entry} | Stop: ${stop} | Target: ${target}
Price change: ${priceChangePct}%
Volume: ${volumeRatio}x average
EMA distance: ${emaDistPct}%

Write exactly:
ANALYSIS: (2 sentences max — why this setup is valid right now)
RISKS: (1 sentence — biggest risk)
PLAN: (1 sentence — exact execution)
VERDICT: (BUY/SELL/SKIP with one word reason)`;

  try {
    const text = await callClaudeWithTimeout(
      () =>
        scanMode === "expensive"
          ? callClaudeWithFallback(claudePrompt, 700)
          : callClaudeCheap(claudePrompt, 700),
      CLAUDE_PER_TICKER_MS
    );
    const parsed = parseSectionedClaude(text);
    if (parsed.analysis) setup.grokAnalysis = parsed.analysis;
    if (parsed.risks) setup.grokRisks = parsed.risks;
    if (parsed.plan) {
      setup.grokPlan = parsed.plan;
      setup.plan = parsed.plan;
    }
    if (parsed.verdict) setup.aiVerdict = parsed.verdict;
    const parts = [];
    if (parsed.analysis) parts.push(`Analysis: ${parsed.analysis}`);
    if (parsed.risks) parts.push(`Risks: ${parsed.risks}`);
    if (parsed.plan) parts.push(`Plan: ${parsed.plan}`);
    if (parts.length) setup.aiCoPilot = parts.join("\n");
  } catch (e) {
    console.warn("scan.js Claude ticker", ticker, e?.message || e);
    setup.grokAnalysis = "Analysis pending";
  }
  setup.drivingText = formatDrivingAlert(setup);
}

async function runScan(event) {
  const headers = { ...cors, "Content-Type": "application/json" };

  try {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ success: false, error: "POST only" }),
    };
  }

  if (!process.env.TRADIER_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        success: false,
        error: "TRADIER_TOKEN not configured",
      }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    body = {};
  }

  let mode = "cheap";
  if (body.mode === "expensive" || body.mode === "cheap") {
    mode = body.mode;
  }

  const requestedMode = mode;
  let scanMode = mode;
  let scanStatus = "ok";
  const nowEt = new Date();
  const optionsRth = isUsEquityOptionsRthEt(nowEt);
  const forceAlertsAfterHours = body.forceAlertsAfterHours === true;
  const allowCatalystGrokOutsideWindow =
    body.allowCatalystGrokOutsideWindow === true;
  if (
    requestedMode === "expensive" &&
    !isEtGrokWindow(nowEt) &&
    !allowCatalystGrokOutsideWindow
  ) {
    scanMode = "cheap";
    scanStatus = "outside_window";
  }

  try {
    await applyOptimizedParams(true);

    const P0 = getOptimizedParams();
    console.log(
      `scan: ADX threshold = ${P0.adxThreshold}, sectorRSBonus = ${P0.sectorRSBonus}`
    );
    if (!optionsRth && !forceAlertsAfterHours) {
      const afterHoursPayload = {
        success: true,
        savedAt: Date.now(),
        status: "after_hours",
        mode: scanMode,
        requestedMode: requestedMode !== scanMode ? requestedMode : undefined,
        meta: {
          minScore: P0.minScore,
          evThreshold: P0.evThreshold,
          grokHealth: "skipped",
          universeSymbols: [
            ...new Set([
              ...DEFAULT_UNIVERSE,
              ...(Array.isArray(body.extraSymbols)
                ? body.extraSymbols
                    .map((s) => String(s || "").trim().toUpperCase())
                    .filter(Boolean)
                : []),
            ]),
          ].slice(0, 48),
          priorityFromNews: Array.isArray(body.prioritySymbols)
            ? body.prioritySymbols
                .map((s) => String(s || "").trim().toUpperCase())
                .filter(Boolean)
            : [],
          backtest7d: null,
          optionsSession: "after_hours",
          optionsSessionNote:
            "Equity options session is 9:30–16:00 ET Mon–Fri — alerts paused.",
        },
        alerts: [],
      };
      await persistLastHudScan(afterHoursPayload);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(afterHoursPayload),
      };
    }

    const extraSyms = Array.isArray(body.extraSymbols)
      ? body.extraSymbols
          .map((s) => String(s || "").trim().toUpperCase())
          .filter(Boolean)
      : [];
    const mergedUniverse = [
      ...new Set([...DEFAULT_UNIVERSE, ...extraSyms]),
    ];
    const prioritySyms = new Set(
      Array.isArray(body.prioritySymbols)
        ? body.prioritySymbols
            .map((s) => String(s || "").trim().toUpperCase())
            .filter(Boolean)
        : []
    );
    /* Prompt 19 — cheap-monitor relays Telegram so cron + UI paths stay consistent without double-send from scan */
    const suppressTelegram = body.suppressTelegram === true;

    /** Phase 1 — rules scan (Tradier + rules engine), hard 8s wall clock. */
    let phase1 = { alerts: [], backtest7: null, P: getOptimizedParams() };
    try {
      phase1 = await Promise.race([
        runPhase1RulesScan({ scanMode, mergedUniverse, prioritySyms }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("phase1_timeout")), PHASE1_MS)
        ),
      ]);
    } catch (e) {
      console.error("scan phase1:", e?.message || e);
    }

    const alerts = phase1.alerts || [];
    const backtest7 = phase1.backtest7;
    const P = phase1.P || getOptimizedParams();

    let grokHealthAgg =
      requestedMode === "expensive" && scanStatus === "outside_window"
        ? "outside_window"
        : "skipped";

    /** Phase 2 — Claude enrichment for top 3 by score only (parallel, 15s each). */
    if (process.env.ANTHROPIC_API_KEY && alerts.length) {
      const top3 = [...alerts]
        .sort((a, b) => (b.score || 0) - (a.score || 0))
        .slice(0, 3);
      if (top3.length) {
        grokHealthAgg = worseGrokHealth(grokHealthAgg, "ok");
        await Promise.all(
          top3.map((s) => enrichTopTickerWithClaude(s, scanMode))
        );
      }
    }

    for (const a of alerts) {
      a.drivingText = formatDrivingAlert(a);
    }

    /* SOHELATOR blueprint — quality-filtered Telegram (Claude + edge / vol / catalyst) (Prompt 19) */
    if (
      alerts.length &&
      !suppressTelegram &&
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      const toSend = prepareAlertsForRelay(alerts, new Date(), {});
      for (const a of toSend) {
        const sym = String(a.symbol || "").toUpperCase();
        const sc = Math.round(Number(a.score) || 0);

        const symKey = `sym-${sym}-${Math.floor(sc / 5) * 5}`;
        const lastSymAlert = SESSION_DEDUPE.get(symKey);
        if (
          lastSymAlert &&
          Date.now() - lastSymAlert < SYMBOL_TELEGRAM_COOLDOWN_MS
        ) {
          console.log(
            `scan: skipping ${sym} — in cooldown (last sent ${Math.round((Date.now() - lastSymAlert) / 60000)}m ago)`
          );
          continue;
        }

        const sustainedVolRatio = sustainedVolRatioOfAlert(a);
        const isVolumeAlert =
          Number.isFinite(sustainedVolRatio) &&
          sustainedVolRatio >= 2.0 &&
          sc < 90 &&
          !hasCatalystSignal(a);
        if (isVolumeAlert) {
          const volKey = `vol-${sym}-${Math.floor(sustainedVolRatio)}x`;
          const lastVolAlert = SESSION_DEDUPE.get(volKey);
          if (
            lastVolAlert &&
            Date.now() - lastVolAlert < VOLUME_TELEGRAM_COOLDOWN_MS
          ) {
            continue;
          }
          SESSION_DEDUPE.set(volKey, Date.now());
        }

        await sendTelegramScanAlert(buildTelegramPrompt19Message(a));
        SESSION_DEDUPE.set(symKey, Date.now());
      }
    }

    const scanPayload = {
      success: true,
      savedAt: Date.now(),
      status: scanStatus,
      mode: scanMode,
      requestedMode: requestedMode !== scanMode ? requestedMode : undefined,
      meta: {
        minScore: P.minScore,
        evThreshold: P.evThreshold,
        grokHealth: grokHealthAgg,
        claudeHealth: grokHealthAgg,
        universeSymbols: mergedUniverse.slice(0, 48),
        priorityFromNews: Array.from(prioritySyms),
        optionsSession: "rth",
        backtest7d: backtest7
          ? {
              ev: backtest7.ev,
              winRate: backtest7.winRate,
              totalSetups: backtest7.totalSetups,
            }
          : null,
      },
      alerts,
    };
    await persistLastHudScan(scanPayload);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(scanPayload),
    };
  } catch (e) {
    console.error("scan.js inner:", e);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        ok: false,
        error: String(e?.message || e),
        message: String(e?.message || e),
        alerts: [],
        watchlist: [],
      }),
    };
  }
  } catch (topLevelError) {
    console.error(
      "scan.js top-level crash:",
      topLevelError?.message || topLevelError
    );
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: false,
        ok: false,
        error: "scan_crash",
        message: String(topLevelError?.message || topLevelError),
        alerts: [],
        watchlist: [],
      }),
    };
  }
}

/**
 * Netlify entry: Promise.race(runScan vs 25s) + outer try/catch so the platform
 * returns 200 JSON on timeout/errors instead of 502 when possible. runScan also
 * has inner try/catch. Requires Netlify Pro for [functions.scan] timeout 26s.
 */
export const handler = async (event) => {
  const timeoutHeaders = { ...cors, "Content-Type": "application/json" };
  try {
    return await Promise.race([
      runScan(event),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Function timeout")),
          FUNCTION_TIMEOUT_MS
        )
      ),
    ]);
  } catch (e) {
    console.error("scan.js handler error:", e?.message);
    return {
      statusCode: 200,
      headers: timeoutHeaders,
      body: JSON.stringify({
        ok: false,
        success: false,
        error: e?.message,
        alerts: [],
        watchlist: [],
        phase: "timeout",
      }),
    };
  }
};
