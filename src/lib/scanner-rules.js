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
  adxThreshold: 18,
  volIgnition: 1.75,
  prevVolIgnition: 1.5,
  sectorRSBonus: 20,
  minScore: 65,
  higherTFPenaltyMax: -15,
  evThreshold: 0.5,
  playTypeBonus: {
    SCALP: 0,
    SWING: 0,
    SCALP_SWING: 0,
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
    const siteID = typeof process !== "undefined" && process.env.NETLIFY_SITE_ID;
    const token = typeof process !== "undefined" && process.env.NETLIFY_TOKEN;
    if (!siteID || !token) return null;
    const { getStore } = await import("@netlify/blobs");
    const store = getStore({
      name: "sohelator-learning",
      siteID,
      token,
    });
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
  const rsi = calcRSI(closes, 14);

  const macdH = calcMACDHist(closes);

  const cur = b.length - 1;
  const prev = b.length - 2;

  const recentVols = b.slice(-6, -1).map((x) => x.volume);
  const volAvg =
    recentVols.length > 0
      ? recentVols.reduce((a, v) => a + v, 0) / recentVols.length
      : 1;
  const curVol = b[cur].volume || 0;
  const prevVol = b[prev].volume || 0;
  const prevAvg = b.length >= 7 ? b.slice(-7, -2).reduce((a, x) => a + x.volume, 0) / 5 : volAvg;

  const volRatio = volAvg > 0 ? curVol / volAvg : 1;
  const prevVolRatio = prevAvg > 0 ? prevVol / prevAvg : 1;

  let score = 50;

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

  // Volume ignition (blueprint: volIgnition, prevVolIgnition)
  if (volRatio >= P.volIgnition) score += 18;
  else if (volRatio >= 1.35) score += 10;
  else if (volRatio < 0.85) score -= 8;

  if (prevVolRatio >= P.prevVolIgnition) score += 8;

  // Sector RS bonus: without sector index feed, use daily trend vs intraday bias as proxy
  let sectorBonus = 0;
  const dCloses = (dailyBars || []).map((x) => num(x.close));
  const dTrend = dailyTrend(dCloses);
  if (dTrend === "up" && bull) sectorBonus = P.sectorRSBonus;
  if (dTrend === "down" && !bull) sectorBonus = P.sectorRSBonus;
  score += sectorBonus;

  // Higher timeframe penalty (blueprint: higherTFPenaltyMax)
  let tfPenalty = 0;
  if (dTrend === "down" && bull) tfPenalty = P.higherTFPenaltyMax;
  else if (dTrend === "up" && !bull) tfPenalty = P.higherTFPenaltyMax * 0.85;
  score += tfPenalty;

  score = clamp(score, 0, 100);

  // Edge + EV (0–1): map composite edge to [0,1] and compare to evThreshold
  const edgeRaw = clamp(
    (score / 100) - 0.5 + (volRatio - 1) * 0.05,
    -1,
    1
  );
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
      prevVolRatio,
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
