/**
 * SOHELATOR blueprint — optimized scanner score (public/optimized_params.json).
 *
 * Rules map:
 *  - adxThreshold:      trend strength gate (ADX vs threshold)
 *  - volIgnition:       current bar vol vs 5-bar avg (ignition)
 *  - prevVolIgnition:   prior bar confirmation vs its avg
 *  - sectorRSBonus:     relative-strength bonus when aligned (proxy: vs SPY trend if dailyBars absent)
 *  - minScore:          reporting only here; callers gate trades
 *  - higherTFPenaltyMax: max penalty when intraday direction fights daily trend
 *  - evThreshold:       expected-value floor for qualitative "edge" flag
 *  - playTypeBonus / scalHorizonBars / swingHorizonBars / riskPctPerR / patternWeights / paramWeights
 *    — tuned by nightly-learn + backtester; merged via applyOptimizedParams().
 */

import {
  calcADX,
  calcMACDHist,
  calcRSI,
  dailyTrend,
  clamp,
  num,
} from "./utils.js";

/** Defaults match shipped public/optimized_params.json (blueprint baseline) */
export const BLUEPRINT_DEFAULT_PARAMS = {
  adxThreshold: 22,
  volIgnition: 1.5,
  prevVolIgnition: 1.25,
  sectorRSBonus: 10,
  minScore: 75,
  higherTFPenaltyMax: -10,
  evThreshold: 0.4,
  playTypeBonus: {
    SCALP: 0,
    SWING: 5,
    SCALP_SWING: 3,
  },
  scalpHorizonBars: 6,
  swingHorizonBars: 48,
  riskPctPerR: 0.25,
  patternWeights: {
    volRatio: 1,
    adx: 1,
    sectorRS: 1,
    gamma: 1,
  },
  paramWeights: {
    adxThreshold: 1,
    volIgnition: 1,
    prevVolIgnition: 1,
    sectorRSBonus: 1,
    minScore: 1,
    evThreshold: 1,
  },
};

/** Written to Netlify blob when health detects runaway tuning (subset of blueprint). */
export const SAFE_OPTIMIZED_PARAMS_BLOB = {
  adxThreshold: 22,
  sectorRSBonus: 10,
  minScore: 75,
  evThreshold: 0.4,
  higherTFPenaltyMax: -10,
};

/** @type {typeof BLUEPRINT_DEFAULT_PARAMS | null} */
let _runtimeMergedParams = null;

/** Debounce network refresh so backtest loops do not fetch on every bar (serverless-friendly). */
let _lastApplyFetchAt = 0;
const APPLY_DEBOUNCE_MS = 45_000;

function deepMerge(a, b) {
  if (!b || typeof b !== "object") return a ? { ...a } : {};
  const out = Array.isArray(a) ? [...a] : { ...a };
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
 * Resolve URL for static JSON deployed with the site (works in Netlify functions when URL is set).
 */
function optimizedParamsUrl() {
  const base =
    (typeof process !== "undefined" && process.env.URL) ||
    (typeof process !== "undefined" && process.env.DEPLOY_PRIME_URL) ||
    "";
  if (!base) return "/optimized_params.json";
  return base.replace(/\/$/, "") + "/optimized_params.json";
}

async function tryLoadBlobParams() {
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("sohelator-learning");
    const raw = await store.get("optimized_params", { type: "json" });
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * SOHELATOR blueprint — fetch public/optimized_params.json, merge nightly blob overrides (if any).
 * @param {boolean} [force] If true, skip debounce (use from nightly-learn / manual refresh).
 * @returns {Promise<typeof BLUEPRINT_DEFAULT_PARAMS>}
 */
export async function applyOptimizedParams(force = false) {
  const now = Date.now();
  if (
    !force &&
    _runtimeMergedParams &&
    now - _lastApplyFetchAt < APPLY_DEBOUNCE_MS
  ) {
    return _runtimeMergedParams;
  }
  _lastApplyFetchAt = now;

  let merged = deepMerge(BLUEPRINT_DEFAULT_PARAMS, {});
  try {
    const url = optimizedParamsUrl();
    const r = await fetch(url, { cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      merged = deepMerge(BLUEPRINT_DEFAULT_PARAMS, j);
    }
  } catch {
    /* keep defaults */
  }
  const blobParams = await tryLoadBlobParams();
  if (blobParams) merged = deepMerge(merged, blobParams);

  _runtimeMergedParams = merged;
  return merged;
}

/**
 * Clear blob overrides so the next `applyOptimizedParams` uses shipped JSON + defaults only.
 * Used when health detects runaway tuned params.
 */
export async function resetOptimizedParams() {
  _runtimeMergedParams = null;
  try {
    const { getStore } = await import("@netlify/blobs");
    const store = getStore("sohelator-learning");
    await store.delete("optimized_params");
  } catch (e) {
    console.warn("resetOptimizedParams delete blob:", e?.message || e);
    try {
      const { getStore } = await import("@netlify/blobs");
      const store = getStore("sohelator-learning");
      await store.setJSON("optimized_params", {});
    } catch (e2) {
      console.warn("resetOptimizedParams setJSON:", e2?.message || e2);
      return false;
    }
  }
  await applyOptimizedParams(true);
  return true;
}

/**
 * Sync read of last merged params (defaults until applyOptimizedParams runs).
 * @returns {typeof BLUEPRINT_DEFAULT_PARAMS}
 */
export function getOptimizedParams() {
  if (!_runtimeMergedParams) {
    return { ...BLUEPRINT_DEFAULT_PARAMS };
  }
  return deepMerge(BLUEPRINT_DEFAULT_PARAMS, _runtimeMergedParams);
}

/**
 * @typedef {object} Bar
 * @property {number} [open]
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} [volume]
 */

/**
 * Core scoring (sync). Prefer `calculateSetupScore` which refreshes params first.
 * @param {Bar[]} bars
 * @param {string} symbol
 * @param {Bar[]} dailyBars
 * @param {Partial<typeof BLUEPRINT_DEFAULT_PARAMS>} [params]
 */
function computeSetupScoreCore(bars, symbol, dailyBars, params = {}) {
  const P = {
    ...getOptimizedParams(),
    ...params,
  };
  const empty = {
    score: 0,
    edge: 0,
    details: { symbol, reason: "insufficient_bars" },
  };

  if (!bars?.length || bars.length < 10) return empty;

  const b = bars.map((x) => ({
    open: num(x.open ?? x.close),
    high: num(x.high),
    low: num(x.low),
    close: num(x.close),
    volume: num(x.volume ?? x.vol),
  }));

  const closes = b.map((x) => x.close);
  const adxCandles = b.map((x) => ({
    high: x.high,
    low: x.low,
    close: x.close,
  }));

  const adx = calcADX(adxCandles, 14);

  /** Hard gate — not trending enough to score (independent of P.adxThreshold tuning). */
  const ADX_MIN_ALERT = 20;
  if (adx < ADX_MIN_ALERT) {
    return {
      score: 0,
      edge: 0,
      details: { symbol, reason: "adx_too_low", adx },
    };
  }

  const rsi = calcRSI(closes, 14);

  const macdH = calcMACDHist(closes);

  const cur = b.length - 1;
  const prev = b.length - 2;
  const cur_close = b[cur].close;

  // Volume calculation — use longer baseline and require sustained surge
  const volBars = b.slice(-51, -1); // 50 bars = ~4 hours of history
  const volBaseline =
    volBars.length >= 10
      ? volBars.slice(0, -5).map((x) => x.volume) // exclude last 5 bars from baseline
      : volBars.map((x) => x.volume);

  const volAvg =
    volBaseline.length > 0
      ? volBaseline.reduce((a, v) => a + v, 0) / volBaseline.length
      : 1;

  // Dynamic floor based on price — higher priced stocks trade more volume
  const priceBasedFloor =
    cur_close > 200 ? 200000 : cur_close > 50 ? 100000 : 50000;
  const effectiveAvg = Math.max(volAvg, priceBasedFloor);

  const curVol = b[cur].volume || 0;
  const prevVol = b[prev].volume || 0;
  const prevPrevVol = b.length >= 3 ? b[b.length - 3].volume || 0 : prevVol;

  // Current ratio (last bar vs baseline)
  const volRatio = effectiveAvg > 0 ? curVol / effectiveAvg : 1;

  // Sustained surge — average of last 3 bars vs baseline
  const recentAvgVol = (curVol + prevVol + prevPrevVol) / 3;
  const sustainedVolRatio =
    effectiveAvg > 0 ? recentAvgVol / effectiveAvg : 1;

  // Price-volume confirmation — volume only counts if price moved with it
  const priceChange = b[cur].close - b[prev].close;
  const priceMoving = Math.abs(priceChange) > b[cur].close * 0.001; // 0.1% move minimum
  const volumeConfirmed = sustainedVolRatio >= 2.0 && priceMoving;
  const volumeSurge3x = sustainedVolRatio >= 3.0 && priceMoving;

  // Volume score contribution — ONLY when price is also moving (max 8 pts total)
  const volScore = volumeConfirmed ? (volumeSurge3x ? 8 : 5) : 0;

  /** Prior-bar ratio vs same baseline (for legacy / HUD) */
  const prevVolRatio = effectiveAvg > 0 ? prevVol / effectiveAvg : 1;

  let score = 40;

  // ADX trend gate (blueprint: adxThreshold)
  if (adx >= P.adxThreshold) score += 15;
  else score -= 8;

  // RSI: reward constructive zones
  if (rsi >= 45 && rsi <= 68) score += 10;
  else if (rsi < 35 || rsi > 72) score -= 8;

  // MACD histogram alignment with last bar direction
  const bull = b[cur].close >= b[cur].open;
  if ((macdH > 0 && bull) || (macdH < 0 && !bull)) score += 8;
  else score -= 5;

  // Volume: confirmer only (max 8 pts); never the main driver vs price action
  score += volScore;

  // Sector RS bonus: without sector index feed, use daily trend vs intraday bias as proxy
  const MAX_SECTOR_BONUS = 10;
  let sectorBonus = 0;
  const dCloses = (dailyBars || []).map((x) => num(x.close));
  const dTrend = dailyTrend(dCloses);
  if (dTrend === "up" && bull)
    sectorBonus = Math.min(P.sectorRSBonus, MAX_SECTOR_BONUS);
  if (dTrend === "down" && !bull)
    sectorBonus = Math.min(P.sectorRSBonus, MAX_SECTOR_BONUS);
  score += sectorBonus;

  // Higher timeframe penalty (blueprint: higherTFPenaltyMax), capped at -10
  const MAX_HTF_PENALTY = -10;
  let tfPenalty = 0;
  if (dTrend === "down" && bull)
    tfPenalty = Math.max(P.higherTFPenaltyMax, MAX_HTF_PENALTY);
  else if (dTrend === "up" && !bull)
    tfPenalty = Math.max(P.higherTFPenaltyMax * 0.85, MAX_HTF_PENALTY);
  score += tfPenalty;

  score = clamp(score, 0, 100);

  // Edge + EV (0–1): price-action dominated; cap volume influence on edge
  const volEdgeBump = clamp((Math.min(sustainedVolRatio, 2.5) - 1) * 0.02, 0, 0.03);
  const edgeRaw = clamp((score / 100) - 0.5 + volEdgeBump, -1, 1);
  const ev01 = (edgeRaw + 1) / 2;

  return {
    score,
    edge: ev01,
    details: {
      symbol,
      adx,
      rsi,
      macdHist: macdH,
      volRatio,
      sustainedVolRatio,
      prevVolRatio,
      priceMoving,
      volumeConfirmed,
      volumeSurge3x,
      volScore,
      dailyTrend: dTrend,
      tfPenalty,
      sectorBonus,
      minScore: P.minScore,
      passesMinScore: score >= P.minScore,
      passesEv: ev01 >= P.evThreshold,
    },
  };
}

/**
 * SOHELATOR blueprint — async entry: always refresh optimized params (debounced) then score.
 * @param {Bar[]} bars       Intraday (e.g. 5m), oldest → newest
 * @param {string} symbol
 * @param {Bar[]} dailyBars
 * @param {Partial<typeof BLUEPRINT_DEFAULT_PARAMS>} [params]
 * @returns {Promise<{ score: number, edge: number, details: Record<string, number | string | boolean> }>}
 */
export async function calculateSetupScore(bars, symbol, dailyBars, params = {}) {
  await applyOptimizedParams(false);
  return computeSetupScoreCore(bars, symbol, dailyBars, params);
}
