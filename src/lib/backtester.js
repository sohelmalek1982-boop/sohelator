/**
 * SOHELATOR blueprint — historical backtest + similarity search (Tradier + scanner-rules only).
 * Walks 5m bars with calculateSetupScore; labels outcomes at scalp/swing horizons for EV / play-type stats.
 */

import {
  getLiquidOptionsWatchlist,
  getTimesales,
  getDailyHistory,
} from "./tradier.js";
import {
  calculateSetupScore,
  applyOptimizedParams,
  getOptimizedParams,
} from "./scanner-rules.js";
import { num } from "./utils.js";

const DEFAULT_UNIVERSE = [
  "SPY",
  "QQQ",
  "IWM",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "META",
  "AMD",
  "GOOGL",
  "AMZN",
];

/** Last run: trades + feature rows for findSimilarSetups */
let _lastSimulatedTrades = [];
/** @type {object | null} */
let _lastReport = null;

/**
 * Feature vector for similarity (normalized).
 * @param {object} d
 */
function featureVec(d) {
  return [
    num(d.adx) / 50,
    num(d.rsi) / 100,
    num(d.volRatio),
    num(d.score) / 100,
  ];
}

function cosineSim(a, b) {
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Classify play type from R-multiples at scalp vs swing horizon (blueprint).
 * @param {number} rScalp
 * @param {number} rSwing
 */
function classifyPlayType(rScalp, rSwing) {
  const absS = Math.abs(rScalp);
  const absW = Math.abs(rSwing);
  if (absS >= absW * 0.85 && Math.sign(rScalp) === Math.sign(rSwing || rScalp))
    return "SCALP";
  if (absW > absS * 1.1) return "SWING";
  return "SCALP_SWING";
}

/**
 * @param {import('./utils.js').Bar[]} bars5
 * @param {number} i entry index (inclusive end of window)
 * @param {number} horizonBars
 * @param {boolean} bull
 * @param {number} riskPctPerR e.g. 0.25 = 0.25% of price = 1R
 */
function rMultipleAt(bars5, i, horizonBars, bull, riskPctPerR) {
  if (i + horizonBars >= bars5.length) return null;
  const entry = num(bars5[i].close);
  const exit = num(bars5[i + horizonBars].close);
  if (!entry) return null;
  const risk = entry * (riskPctPerR / 100);
  if (!risk) return null;
  const raw = bull ? exit - entry : entry - exit;
  return raw / risk;
}

/**
 * Pull data, simulate setups, aggregate EV / win rate / play-type accuracy.
 * @param {number} [days]
 */
export async function runBacktest(days = 60) {
  await applyOptimizedParams();
  const P = getOptimizedParams();
  const scalpH = Math.max(3, Math.round(num(P.scalpHorizonBars, 6)));
  const swingH = Math.max(scalpH + 1, Math.round(num(P.swingHorizonBars, 48)));
  const riskPct = num(P.riskPctPerR, 0.25);

  if (!process.env.TRADIER_TOKEN) {
    throw new Error("TRADIER_TOKEN required for backtest");
  }

  const watchRaw = await getLiquidOptionsWatchlist(DEFAULT_UNIVERSE);
  const watchlist = watchRaw.slice(0, 12);

  const bySymbol = {};
  const allRows = [];

  for (const symbol of watchlist) {
    const bars5 = await getTimesales(symbol, "5min", days);
    const bars15 = await getTimesales(symbol, "15min", Math.min(days, 30));
    const daily = await getDailyHistory(symbol, days + 5);
    if (!bars5.length || bars5.length < 50) {
      bySymbol[symbol] = { error: "insufficient_5m_data", n: bars5.length };
      continue;
    }

    const trades = [];
    const step = 2;
    for (let i = 40; i < bars5.length - swingH - 1; i += step) {
      const window = bars5.slice(i - 39, i + 1);
      const sc = await calculateSetupScore(window, symbol, daily);
      const det = sc.details;
      if (!det.passesMinScore || !det.passesEv) continue;

      const bull = window[window.length - 1].close >= window[window.length - 1].open;
      const rScalp = rMultipleAt(bars5, i, scalpH, bull, riskPct);
      const rSwing = rMultipleAt(bars5, i, swingH, bull, riskPct);
      if (rScalp == null || rSwing == null) continue;

      const playType = classifyPlayType(rScalp, rSwing);
      const bestR = Math.abs(rScalp) >= Math.abs(rSwing) ? rScalp : rSwing;
      const win = bestR >= 0.5;
      const earlyStop = !win && Math.min(rScalp, rSwing) < -1;

      trades.push({
        symbol,
        i,
        score: sc.score,
        edge: sc.edge,
        win,
        rScalp,
        rSwing,
        bestR,
        playType,
        earlyStop,
        features: {
          adx: det.adx,
          rsi: det.rsi,
          volRatio: det.volRatio,
          score: sc.score,
          dailyTrend: det.dailyTrend,
        },
        bars15Sampled: bars15.length,
      });
    }

    bySymbol[symbol] = {
      trades: trades.length,
      winRate:
        trades.length > 0
          ? trades.filter((t) => t.win).length / trades.length
          : 0,
      avgR:
        trades.length > 0
          ? trades.reduce((a, t) => a + t.bestR, 0) / trades.length
          : 0,
    };
    allRows.push(...trades);
  }

  const wins = allRows.filter((t) => t.win);
  const winRate = allRows.length ? wins.length / allRows.length : 0;
  const avgR = allRows.length
    ? allRows.reduce((a, t) => a + t.bestR, 0) / allRows.length
    : 0;
  const ev =
    allRows.length > 0
      ? allRows.reduce((a, t) => a + Math.max(t.bestR, -2), 0) / allRows.length
      : 0;

  const playBuckets = { SCALP: [], SWING: [], SCALP_SWING: [] };
  for (const t of allRows) {
    if (playBuckets[t.playType]) playBuckets[t.playType].push(t);
  }
  const playTypeAccuracy = {};
  for (const k of Object.keys(playBuckets)) {
    const arr = playBuckets[k];
    playTypeAccuracy[k] =
      arr.length > 0 ? arr.filter((x) => x.win).length / arr.length : 0;
  }

  const suggestions = suggestParamsFromBacktest(allRows, P);

  const report = {
    days,
    watchlist,
    symbolsProcessed: watchlist.length,
    totalSetups: allRows.length,
    winRate,
    avgR,
    ev,
    playTypeAccuracy,
    bySymbol,
    suggestions,
    optimizedParamsSnapshot: { ...P },
    /** For nightly-learn correlation + pattern discovery */
    simulatedTrades: allRows,
  };

  _lastSimulatedTrades = allRows;
  _lastReport = report;

  return report;
}

/**
 * Heuristic tuning hints from backtest distribution (blueprint).
 * @param {object[]} rows
 * @param {object} P
 */
function suggestParamsFromBacktest(rows, P) {
  if (!rows.length)
    return { note: "no setups — widen thresholds or extend history" };

  const winFeat = rows.filter((r) => r.win).map((r) => r.features);
  const loseFeat = rows.filter((r) => !r.win).map((r) => r.features);

  const avg = (arr, k) =>
    arr.length ? arr.reduce((a, x) => a + num(x[k]), 0) / arr.length : 0;

  const adxW = avg(winFeat, "adx");
  const adxL = avg(loseFeat, "adx");
  const volW = avg(winFeat, "volRatio");
  const volL = avg(loseFeat, "volRatio");

  const out = {
    note: "SOHELATOR blueprint — suggestions only; nightly-learn merges with trade_log",
    adxThreshold:
      adxL > adxW + 3 ? "consider +1–2 (losers had higher ADX)" : "stable",
    volIgnition:
      volW > volL + 0.15 ? "consider +0.05–0.1 (winners had stronger vol ignition)" : "stable",
    minScore:
      winRate(rows) < 0.45 ? "consider -2 to +3 minScore after EV check" : "stable",
    playTypeBonus: {
      SCALP: playTypeEdge(rows, "SCALP"),
      SWING: playTypeEdge(rows, "SWING"),
      SCALP_SWING: playTypeEdge(rows, "SCALP_SWING"),
    },
  };
  return out;
}

function winRate(rows) {
  if (!rows.length) return 0;
  return rows.filter((r) => r.win).length / rows.length;
}

function playTypeEdge(rows, pt) {
  const sub = rows.filter((r) => r.playType === pt);
  if (!sub.length) return 0;
  return sub.filter((r) => r.win).length / sub.length - 0.5;
}

/** Cap on returned rows; actual count is always `results.length` (may be lower if cache is small). */
export const SIMILAR_SETUPS_MAX_RESULTS = 15;

/**
 * Compare current setup to last backtest + optional historical trades list.
 * @param {object} currentSetup { symbol, bars, meta?: object }
 * @param {number} [maxResults]
 */
export async function findSimilarSetups(
  currentSetup,
  maxResults = SIMILAR_SETUPS_MAX_RESULTS
) {
  await applyOptimizedParams();

  const meta = currentSetup.meta || {};
  const sc =
    currentSetup.bars?.length >= 10
      ? await calculateSetupScore(
          currentSetup.bars,
          currentSetup.symbol || "",
          currentSetup.dailyBars || [],
        )
      : { score: 50, details: {} };
  const det = sc.details;

  const query = {
    adx: num(meta.adx ?? det.adx),
    rsi: num(meta.rsi ?? det.rsi),
    volRatio: num(meta.volRatio ?? det.volRatio),
    score: num(meta.score ?? sc.score),
  };

  const qv = featureVec(query);

  const scored = _lastSimulatedTrades.map((t) => ({
    sim: t,
    simScore: cosineSim(qv, featureVec(t.features)),
  }));

  scored.sort((a, b) => b.simScore - a.simScore);

  return scored.slice(0, maxResults).map((x) => ({
    similarity: Math.round(x.simScore * 1000) / 1000,
    symbol: x.sim.symbol,
    playType: x.sim.playType,
    win: x.sim.win,
    bestR: Math.round(x.sim.bestR * 100) / 100,
    patternNote: x.sim.win
      ? "historical win in similar ADX/RSI/vol/score regime"
      : "historical loss — check conflict with higher timeframe",
    features: x.sim.features,
  }));
}

export function getLastBacktestReport() {
  return _lastReport;
}
