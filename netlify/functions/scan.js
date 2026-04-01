/**
 * SOHELATOR blueprint — live scanner: liquid universe → multi-TF data → scored setups
 * → historical similarity → rich dashboard alerts (+ optional driving string).
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12):
 * POST body may include extraSymbols, prioritySymbols, catalystNewsSummary (from cheap-monitor news pass).
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
import { runBacktest, findSimilarSetups } from "../../src/lib/backtester.js";
import { formatDrivingAlert } from "../../src/lib/alert-formatter.js";
import { num } from "../../src/lib/utils.js";
import { callGrok } from "../../src/lib/grok.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

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
  const p = Number(last) || 0;
  if (mode === "expensive") return p >= 150;
  return p < 150;
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

function historicalSummary(similar) {
  if (!similar?.length) return "Historical: no close matches in last backtest cache.";
  const wins = similar.filter((s) => s.win).length;
  const wr = Math.round((wins / similar.length) * 100);
  const top = similar[0];
  return `Historical: ${similar.length} near matches, ~${wr}% wins in sample. Closest: ${top.symbol} (${playLabelPretty(top.playType)}, sim=${top.similarity}). ${top.patternNote || ""}`;
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

/** Two expensive-model attempts, then one cheap-model fallback (Prompt 8). */
async function callGrokExpensiveWithFallback(aiPrompt, maxTok) {
  const expensiveModel =
    process.env.GROK_MODEL_EXPENSIVE || "grok-4.20-reasoning";
  const cheapModel =
    process.env.GROK_MODEL_CHEAP || "grok-4-1-fast-reasoning";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callGrok(expensiveModel, aiPrompt, maxTok);
      return { text, health: "ok" };
    } catch (e) {
      lastErr = e;
      console.warn("scan.js Grok expensive attempt", attempt + 1, e?.message || e);
    }
  }
  try {
    console.warn("scan.js Grok: falling back to cheap model after expensive failures");
    const text = await callGrok(cheapModel, aiPrompt, maxTok);
    return { text, health: "fallback_cheap" };
  } catch (e2) {
    throw lastErr || e2;
  }
}

export const handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };

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

    /** Warm similarity index for findSimilarSetups (7d fast pass). */
    let backtest7 = null;
    try {
      backtest7 = await runBacktest(7);
    } catch (e) {
      console.warn("scan.js runBacktest(7) optional:", e?.message || e);
    }

    const P0 = getOptimizedParams();
    if (!optionsRth && !forceAlertsAfterHours) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
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
            backtest7d: backtest7
              ? {
                  ev: backtest7.ev,
                  winRate: backtest7.winRate,
                  totalSetups: backtest7.totalSetups,
                }
              : null,
            optionsSession: "after_hours",
            optionsSessionNote:
              "Equity options session is 9:30–16:00 ET Mon–Fri — alerts paused.",
          },
          alerts: [],
        }),
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
    const catalystNewsSummary =
      typeof body.catalystNewsSummary === "string"
        ? body.catalystNewsSummary.slice(0, 1500)
        : "";

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
    const take = sortedFiltered.slice(0, 12);

    const P = getOptimizedParams();
    const scalpH = Math.max(3, Math.round(num(P.scalpHorizonBars, 6)));
    const swingH = Math.max(scalpH + 1, Math.round(num(P.swingHorizonBars, 48)));
    const riskPct = num(P.riskPctPerR, 0.25);

    const alerts = [];
    let grokHealthAgg =
      requestedMode === "expensive" && scanStatus === "outside_window"
        ? "outside_window"
        : "skipped";

    for (const row of take) {
      const symbol = row.symbol;
      const [bars5, bars15, daily] = await Promise.all([
        getTimesales(symbol, "5min", 5),
        getTimesales(symbol, "15min", 5),
        getDailyHistory(symbol, 120),
      ]);

      if (!bars5.length || bars5.length < 10) continue;

      const sc = await calculateSetupScore(bars5, symbol, daily);
      const minScore = num(P.minScore, 65);
      if (sc.score < minScore) continue;

      const similar = await findSimilarSetups(
        { symbol, bars: bars5, dailyBars: daily },
        15
      );

      const bull = num(bars5[bars5.length - 1].close) >= num(bars5[bars5.length - 1].open);
      const playRaw = livePlayTypeFromBars(bars5, scalpH, swingH, riskPct);
      const playTypeLabel = playLabelPretty(playRaw);
      const lv = levelsFromLastBar(bars5, bull, riskPct);
      const hist = historicalSummary(similar);

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
        ev: sc.edge,
        projectedEv: backtest7?.ev ?? null,
        thetaCountdown: undefined,
        similar,
        details: sc.details,
      };

      try {
        const sug = await suggestAtmOption(symbol, row.last, bull);
        if (sug) setup.suggestedOption = sug;
      } catch (e) {
        console.warn("scan suggestAtmOption", symbol, e?.message || e);
      }

      /* GROK_API_KEY — Prompt 8: ET window + 2× expensive + cheap fallback */
      if (scanMode === "expensive" && process.env.GROK_API_KEY) {
        try {
          const priorityHit = prioritySyms.has(setup.symbol);
          const catBlock =
            catalystNewsSummary
              ? `

Recent market headlines (catalyst context for the session):
${catalystNewsSummary}
${
  priorityHit
    ? `This symbol (${setup.symbol}) appeared in our universe ∩ headline scan. If a *fresh* catalyst in the text clearly supports a tactical trade in ${setup.symbol}, your NET VERDICT line MUST begin exactly: HIGH-PROBABILITY CATALYST PLAY —`
    : `If a headline clearly ties a *fresh* catalyst to ${setup.symbol}, your NET VERDICT line MUST begin exactly: HIGH-PROBABILITY CATALYST PLAY —`
}
Otherwise use a normal conviction NET VERDICT (no catalyst prefix).`
              : "";

          const aiPrompt = `You are SOHELATOR's aggressive co-pilot. Lead with system signal. Never veto unless score <40. End with single-line NET VERDICT.

System setup (JSON):
${JSON.stringify({
  symbol: setup.symbol,
  score: setup.score,
  edge: setup.edge,
  playTypeLabel: setup.playTypeLabel,
  direction: setup.direction,
  entry: setup.entry,
  stop: setup.stop,
  target: setup.target,
  historicalSummary: setup.historicalSummary,
  ev: setup.ev,
  projectedEv: setup.projectedEv,
  rulesAiVerdict: setup.aiVerdict,
})}
${catBlock}

Respond with a few short lines, then exactly one line: NET VERDICT: <one line>`;

          const { text: grokOut, health: gh } = await callGrokExpensiveWithFallback(
            aiPrompt,
            1200
          );
          grokHealthAgg = worseGrokHealth(grokHealthAgg, gh);
          setup.aiCoPilot = grokOut;
          const netMatch = grokOut.match(/NET VERDICT:\s*(.+)/i);
          setup.aiVerdict = netMatch
            ? netMatch[1].trim()
            : grokOut
                .trim()
                .split("\n")
                .filter(Boolean)
                .pop() || grokOut;
        } catch (e) {
          console.warn("scan.js Grok (all attempts failed):", e?.message || e);
          grokHealthAgg = worseGrokHealth(grokHealthAgg, "error");
          setup.aiCoPilot = `Grok unavailable: ${e?.message || e}`;
        }
      }

      setup.drivingText = formatDrivingAlert(setup);

      alerts.push(setup);
    }

    if (
      alerts.length &&
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      for (const a of alerts) {
        const when = a.alertedAtIso
          ? new Date(a.alertedAtIso).toLocaleString("en-US", {
              timeZone: "America/New_York",
              hour: "numeric",
              minute: "2-digit",
              second: "2-digit",
              hour12: true,
            }) + " ET"
          : "now";
        const und =
          a.underlyingAtAlert != null
            ? ` · underlying ~$${Number(a.underlyingAtAlert).toFixed(2)}`
            : "";
        await sendTelegramScanAlert(
          `SOHELATOR ${a.symbol} score ${Math.round(a.score)}/100\n${when}${und}\n${String(a.drivingText || a.aiVerdict || "").slice(0, 500)}`
        );
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        status: scanStatus,
        mode: scanMode,
        requestedMode: requestedMode !== scanMode ? requestedMode : undefined,
        meta: {
          minScore: P.minScore,
          evThreshold: P.evThreshold,
          grokHealth: grokHealthAgg,
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
      }),
    };
  } catch (e) {
    console.error("scan.js", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ success: false, error: String(e?.message || e) }),
    };
  }
};
