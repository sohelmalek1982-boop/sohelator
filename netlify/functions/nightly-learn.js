/**
 * SOHELATOR blueprint — nightly learning job: backtest → trade_log feedback → pattern discovery → persist tuned params.
 *
 * Persists to Netlify Blobs (`sohelator-learning` store) when NETLIFY_SITE_ID + NETLIFY_TOKEN are set.
 * Static files under public/ are updated at deploy; runtime overrides live in the blob (merged in applyOptimizedParams).
 *
 * Schedule via Netlify cron or POST manually. Increase function timeout in netlify.toml if backtest exceeds default.
 */

import { getStore } from "@netlify/blobs";
import { runBacktest } from "../../src/lib/backtester.js";
import {
  applyOptimizedParams,
  getOptimizedParams,
  BLUEPRINT_DEFAULT_PARAMS,
} from "../../src/lib/scanner-rules.js";
import { callGrok } from "../../src/lib/grok.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function siteUrl() {
  return (
    (typeof process !== "undefined" && process.env.URL) ||
    (typeof process !== "undefined" && process.env.DEPLOY_PRIME_URL) ||
    ""
  ).replace(/\/$/, "");
}

async function fetchPublicJson(path) {
  const base = siteUrl();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/${path}`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function num(x, fb = 0) {
  const n = parseFloat(String(x));
  return Number.isFinite(n) ? n : fb;
}

function deepMerge(a, b) {
  if (!b || typeof b !== "object") return a ? { ...a } : {};
  const out = { ...a };
  for (const k of Object.keys(b)) {
    const bv = b[k];
    const av = out[k];
    if (
      bv &&
      typeof bv === "object" &&
      !Array.isArray(bv) &&
      av &&
      typeof av === "object" &&
      !Array.isArray(av)
    ) {
      out[k] = deepMerge(av, bv);
    } else {
      out[k] = bv;
    }
  }
  return out;
}

/**
 * Blueprint reward/penalty on paramWeights + light numeric nudges from real trades.
 * Win ≥ +0.8R → +15% on paramWeights keys.
 * Loss or early stop → -25% on paramWeights keys.
 */
function applyTradeLogFeedback(baseParams, tradeLog) {
  const p = deepMerge(BLUEPRINT_DEFAULT_PARAMS, baseParams);
  const pw = { ...p.paramWeights };
  const list = Array.isArray(tradeLog) ? tradeLog : [];

  for (const t of list) {
    const r = num(t.rMultiple ?? t.r ?? t.bestR);
    const early = !!t.earlyStop;
    const isWin = t.outcome === "win" || t.outcome === "WIN" || t.win === true;

    if (isWin && r >= 0.8) {
      for (const k of Object.keys(pw)) {
        pw[k] = Math.min(2.5, num(pw[k], 1) * 1.15);
      }
      const f = t.features || {};
      if (num(f.adx) > 24) p.adxThreshold = Math.max(14, p.adxThreshold - 0.25);
      if (num(f.volRatio) > 1.85) p.volIgnition = Math.max(1.2, p.volIgnition - 0.03);
    } else if (t.outcome === "loss" || t.outcome === "LOSS" || early) {
      for (const k of Object.keys(pw)) {
        pw[k] = Math.max(0.2, num(pw[k], 1) * 0.75);
      }
    }
  }

  p.paramWeights = pw;
  return p;
}

/**
 * Simple correlation notes: winners vs losers on vol / ADX (gamma placeholder — Tradier chain optional later).
 */
function discoverPatterns(backtestReport, tradeLog) {
  const sim = backtestReport.simulatedTrades || [];
  const wins = sim.filter((x) => x.win);
  const losses = sim.filter((x) => !x.win);

  const avg = (arr, key) =>
    arr.length
      ? arr.reduce((a, x) => a + num(x.features?.[key]), 0) / arr.length
      : 0;

  const patterns = [];

  if (wins.length && losses.length) {
    patterns.push({
      id: `vol_adx_${Date.now()}`,
      kind: "volRatio_adx",
      winAvgVolRatio: Math.round(avg(wins, "volRatio") * 1000) / 1000,
      lossAvgVolRatio: Math.round(avg(losses, "volRatio") * 1000) / 1000,
      winAvgAdx: Math.round(avg(wins, "adx") * 10) / 10,
      lossAvgAdx: Math.round(avg(losses, "adx") * 10) / 10,
      note:
        avg(wins, "volRatio") > avg(losses, "volRatio")
          ? "SOHELATOR blueprint: winners skew higher vol ignition vs losers (backtest)"
          : "mixed vol regime — review minScore / evThreshold",
    });
  }

  const real = Array.isArray(tradeLog) ? tradeLog : [];
  if (real.length) {
    const rw = real.filter(
      (t) => t.outcome === "win" || t.win === true
    ).length;
    patterns.push({
      id: `real_trade_sample_${Date.now()}`,
      kind: "trade_log_summary",
      trades: real.length,
      winRate: Math.round((rw / real.length) * 1000) / 1000,
      note: "SOHELATOR blueprint: live trade_log sample vs backtest alignment",
    });
  }

  return patterns;
}

function learningStore() {
  return getStore({
    name: "sohelator-learning",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

async function persistLearning(optimizedParams, patterns) {
  const out = { saved: false, blob: false };
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) {
    out.note =
      "NETLIFY_SITE_ID / NETLIFY_TOKEN not set — copy `response.persistJson` into public/ on next deploy";
    return out;
  }
  try {
    const store = learningStore();
    await store.set("optimized_params", JSON.stringify(optimizedParams), {
      metadata: { contentType: "application/json" },
    });
    await store.set("historical_patterns", JSON.stringify(patterns), {
      metadata: { contentType: "application/json" },
    });
    out.saved = true;
    out.blob = true;
  } catch (e) {
    out.error = String(e?.message || e);
  }
  return out;
}

export const handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET" && event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "GET or POST only" }),
    };
  }

  if (!process.env.TRADIER_TOKEN) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "TRADIER_TOKEN required for backtest",
      }),
    };
  }

  try {
    await applyOptimizedParams();

    const backtestReport = await runBacktest(60);

    const tradeLogFromSite = (await fetchPublicJson("trade_log.json")) || [];
    const tradeLogFromEnv = process.env.TRADE_LOG_JSON
      ? JSON.parse(process.env.TRADE_LOG_JSON)
      : [];
    const tradeLog = [
      ...normTradeList(tradeLogFromSite),
      ...normTradeList(tradeLogFromEnv),
    ];

    let tuned = deepMerge(getOptimizedParams(), {});
    tuned = applyTradeLogFeedback(tuned, tradeLog);

    const priorPatterns = (await fetchPublicJson("historical_patterns.json")) || [];
    const discovered = discoverPatterns(backtestReport, tradeLog);
    const patterns = [
      ...(Array.isArray(priorPatterns) ? priorPatterns : []),
      ...discovered,
    ].slice(-200);

    const persist = await persistLearning(tuned, patterns);

    const projectedEv =
      Math.round((backtestReport.ev || 0) * 1000) / 1000;

    const nightlyReport = {
      ok: true,
      ranAt: new Date().toISOString(),
      backtest: {
        totalSetups: backtestReport.totalSetups,
        winRate: backtestReport.winRate,
        avgR: backtestReport.avgR,
        ev: backtestReport.ev,
        playTypeAccuracy: backtestReport.playTypeAccuracy,
      },
      learnings: {
        whatWorked:
          backtestReport.winRate > 0.5
            ? "Backtest win rate above 50% — consider trusting passesMinScore + evThreshold"
            : "Backtest win rate below 50% — review minScore / horizons",
        whatFailed:
          backtestReport.avgR < 0
            ? "Negative avg R — tighten gates or reduce playTypeBonus noise"
            : "Avg R non-negative in sample",
        newEdge: patterns[0]?.note || "n/a",
        projectedEv,
        backtestSuggestions: backtestReport.suggestions || null,
      },
      tradeLogUsed: tradeLog.length,
      persist,
      /** Commit these into repo public/ when not using blobs, or rely on blob merge at runtime */
      persistJson: {
        optimized_params: tuned,
        historical_patterns: patterns,
      },
    };

    /* Prompt 8 — nightly uses cheap model only; 2 attempts (no ET gate — job runs off-hours) */
    if (process.env.GROK_API_KEY) {
      const cheapModel =
        process.env.GROK_MODEL_CHEAP || "grok-4-1-fast-reasoning";
      const learnPrompt = `You summarize SOHELATOR nightly learning. What went right, what went wrong, and any new patterns worth noting — concise bullets. Base only on this JSON:\n${JSON.stringify(nightlyReport)}`;
      let lastErr;
      let got = false;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          nightlyReport.grokLearningsSummary = await callGrok(
            cheapModel,
            learnPrompt,
            2000
          );
          nightlyReport.grokNightlyStatus = "ok";
          got = true;
          break;
        } catch (e) {
          lastErr = e;
          console.warn("nightly-learn Grok attempt", attempt + 1, e?.message || e);
        }
      }
      if (!got) {
        nightlyReport.grokNightlyStatus = "error";
        nightlyReport.grokLearningsSummary = `Grok summary failed: ${lastErr?.message || lastErr}`;
      }
    }

    await applyOptimizedParams();

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(nightlyReport),
    };
  } catch (e) {
    console.error("nightly-learn", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};

function normTradeList(x) {
  if (!Array.isArray(x)) return [];
  return x;
}
