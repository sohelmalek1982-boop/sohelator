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

/** SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19) */
const TELEGRAM_ALERT_MIN_SCORE = 65;

function volRatioOfAlert(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
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
  let grok = String(a.aiCoPilot || a.aiVerdict || "")
    .replace(/\s+/g, " ")
    .trim();
  if (grok.length > 600) grok = grok.slice(0, 597) + "…";
  const plan = String(a.plan || "").trim();
  const histLine = historicalMatchesShort(a);

  const hi = [];
  if (score >= 90) hi.push("⚡ SCORE 90+ — TOP TIER");
  if (volRatioOfAlert(a) >= 3) hi.push("⚡ VOL SURGE 3×+");
  if (hasCatalystSignal(a)) hi.push("⚡ CATALYST / NEWS");
  if (hasRegimeOrLevelKeywords(a)) hi.push("⚡ REGIME / LEVEL / REVERSAL — READ FULL GROK");

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
    process.env.GROK_MODEL_EXPENSIVE || "grok-4.20-0309-reasoning";
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

const BATCH_GROK_MAX_TOK = 2500;

/** Parse batched Grok reply: JSON array of { symbol, analysis, risks, plan, netVerdict }. */
function parseBatchedGrokVerdicts(rawText) {
  const out = new Map();
  if (!rawText || typeof rawText !== "string") return out;
  let s = rawText.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  const fillFromArray = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const row of arr) {
      const sym = String(row?.symbol || "").trim().toUpperCase();
      if (!sym) continue;
      const analysisRaw = String(row.analysis ?? "").trim();
      const coPilotFallback = String(
        row.coPilot ?? row.co_pilot ?? row.notes ?? ""
      ).trim();
      out.set(sym, {
        analysis: analysisRaw || coPilotFallback,
        risks: String(row.risks ?? "").trim(),
        plan: String(row.plan ?? "").trim(),
        netVerdict: String(
          row.netVerdict ?? row.NET_VERDICT ?? row.net_verdict ?? ""
        ).trim(),
      });
    }
  };

  try {
    fillFromArray(JSON.parse(s));
    if (out.size) return out;
  } catch {
    /* bracket slice */
  }
  const i = s.indexOf("[");
  const j = s.lastIndexOf("]");
  if (i >= 0 && j > i) {
    try {
      fillFromArray(JSON.parse(s.slice(i, j + 1)));
    } catch {
      /* ignore */
    }
  }
  return out;
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
            backtest7d: null,
            optionsSession: "after_hours",
            optionsSessionNote:
              "Equity options session is 9:30–16:00 ET Mon–Fri — alerts paused.",
          },
          alerts: [],
        }),
      };
    }

    /** Warm similarity index for findSimilarSetups (7d fast pass). */
    let backtest7 = null;
    try {
      backtest7 = await runBacktest(7);
    } catch (e) {
      console.warn("scan.js runBacktest(7) optional:", e?.message || e);
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

    /* Prompt 19 — cheap-monitor relays Telegram so cron + UI paths stay consistent without double-send from scan */
    const suppressTelegram = body.suppressTelegram === true;

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
        : sortedFiltered.slice(0, 10);

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

      setup.drivingText = formatDrivingAlert(setup);

      alerts.push(setup);
    }

    /* Expensive: one batched Grok call for all alerts (Netlify timeout — was N sequential calls). */
    if (scanMode === "expensive" && process.env.GROK_API_KEY && alerts.length) {
      try {
        const setupsPayload = alerts.map((setup) => ({
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
        }));

        const priorityInBatch = [
          ...new Set(
            alerts
              .filter((a) => prioritySyms.has(a.symbol))
              .map((a) => a.symbol)
          ),
        ];

        const catBlock =
          catalystNewsSummary
            ? `

Recent market headlines (catalyst context for the session):
${catalystNewsSummary}

Symbols in this batch that appeared in universe ∩ headline scan: ${priorityInBatch.length ? priorityInBatch.join(", ") : "(none)"}.
For any such symbol, if a *fresh* catalyst in the text clearly supports a tactical trade in that symbol, that symbol's netVerdict MUST begin exactly: HIGH-PROBABILITY CATALYST PLAY —
For other symbols, if a headline clearly ties a *fresh* catalyst to that symbol, the same prefix applies.
Otherwise use a normal conviction netVerdict (no catalyst prefix).`
            : "";

        const symList = alerts.map((a) => a.symbol).join(", ");
        const aiPrompt = `You are SOHELATOR's aggressive trading co-pilot. Market is live. Analyze each setup below and return actionable intelligence.

For each symbol provide:
- analysis: 2-3 lines covering trend context, key level behavior, and why this setup has edge RIGHT NOW
- risks: 1 line on what invalidates this trade
- plan: specific action — scale in, wait for pullback, full size, avoid, etc.
- netVerdict: one conviction line starting with LONG, SHORT, WAIT, or AVOID

Rules:
- Never veto unless score < 40
- Be specific, not generic — mention actual price levels from the data
- If direction is short and daily trend is down, that is confluence — say so
- If score >= 90 lead with HIGH CONVICTION

Setups:
${JSON.stringify(setupsPayload)}
${catBlock}

Respond ONLY with a valid JSON array. One object per symbol with fields: symbol, analysis, risks, plan, netVerdict. Include every symbol: ${symList}.`;

        const { text: grokOut, health: gh } = await callGrokExpensiveWithFallback(
          aiPrompt,
          BATCH_GROK_MAX_TOK
        );
        grokHealthAgg = worseGrokHealth(grokHealthAgg, gh);
        const verdictMap = parseBatchedGrokVerdicts(grokOut);
        for (const setup of alerts) {
          const sym = String(setup.symbol || "").trim().toUpperCase();
          const row = verdictMap.get(sym);
          if (row) {
            if (row.analysis) setup.grokAnalysis = row.analysis;
            if (row.risks) setup.grokRisks = row.risks;
            setup.plan = String(row.plan || "").trim();
            if (setup.plan) setup.grokPlan = setup.plan;
            if (row.netVerdict) setup.aiVerdict = row.netVerdict;
            const parts = [];
            if (row.analysis) parts.push(`Analysis: ${row.analysis}`);
            if (row.risks) parts.push(`Risks: ${row.risks}`);
            if (row.plan) parts.push(`Plan: ${row.plan}`);
            if (parts.length) setup.aiCoPilot = parts.join("\n");
          } else if (verdictMap.size > 0) {
            setup.aiCoPilot = `Grok batch: missing entry for ${sym}`;
          } else {
            setup.aiCoPilot = `Grok batch: could not parse JSON (${String(grokOut || "").length} chars)`;
          }
        }
        for (const a of alerts) {
          a.drivingText = formatDrivingAlert(a);
        }
      } catch (e) {
        console.warn("scan.js batched Grok failed:", e?.message || e);
        grokHealthAgg = worseGrokHealth(grokHealthAgg, "error");
        for (const setup of alerts) {
          setup.aiCoPilot = `Grok unavailable: ${e?.message || e}`;
        }
        for (const a of alerts) {
          a.drivingText = formatDrivingAlert(a);
        }
      }
    }

    /* SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19) */
    if (
      alerts.length &&
      !suppressTelegram &&
      process.env.TELEGRAM_BOT_TOKEN &&
      process.env.TELEGRAM_CHAT_ID
    ) {
      for (const a of alerts) {
        if (Number(a.score) < TELEGRAM_ALERT_MIN_SCORE) continue;
        await sendTelegramScanAlert(buildTelegramPrompt19Message(a));
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
