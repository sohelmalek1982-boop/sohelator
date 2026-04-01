/**
 * All signal / scanner thresholds: override via Netlify env after your own backtests.
 * Defaults = classical TA baselines (RSI 30/50/70 bands, ADX chop gate 20, Bollinger 0.5)
 * — not curve-fit; tune env vars from historical sims.
 */
function numEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function intEnv(name, fallback) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** NaN = feature off */
function optNumEnv(name) {
  const v = process.env[name];
  if (v == null || String(v).trim() === "") return NaN;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : NaN;
}

function getScannerParams() {
  return {
    /** Subtract from regime minADX before stage gate (0 = use regime value as-is). */
    adxRegimeOffset: Math.max(0, numEnv("SCANNER_STAGE_ADX_REGIME_OFFSET", 0)),
    /** When last-bar vol / 20-bar avg >= this, subtract ADX slack (disabled if unset). */
    volSurgeMult: optNumEnv("SCANNER_STAGE_VOL_SURGE_MULT"),
    volSurgeAdxSubtract: Math.max(0, numEnv("SCANNER_STAGE_VOL_SURGE_ADX_SUBTRACT", 0)),
    /** Hard minimum for effective ADX gate after slack (optional). */
    adxGateFloor: optNumEnv("SCANNER_STAGE_ADX_GATE_FLOOR"),
    /** BEAR CONFIRMED RSI band (Wilder-style mid-band for continuation). */
    bearConfirmedRsiLo: intEnv("SCANNER_BEAR_CONFIRMED_RSI_LO", 30),
    bearConfirmedRsiHi: intEnv("SCANNER_BEAR_CONFIRMED_RSI_HI", 50),
    /** Extra bear score when RSI oversold & structure bearish (0 = off). */
    bearOversoldRsiMax: intEnv("SCANNER_BEAR_OVERSOLD_RSI_MAX", 30),
    bearOversoldScoreBonus: intEnv("SCANNER_BEAR_OVERSOLD_SCORE_BONUS", 0),
    /** Skip ADX chop gate when day change <= this % and bearish structure (disabled if unset). */
    flushDayChangePct: optNumEnv("SCANNER_FLUSH_DAY_CHANGE_PCT"),
    /** VWAP dist % (negative) required with flush, e.g. -5 means -5%. */
    flushVwapDistPct: optNumEnv("SCANNER_FLUSH_VWAP_DIST_PCT"),
  };
}

function getSignalParams() {
  return {
    adxChopMax: numEnv("SIGNAL_ADX_CHOP_MAX", 20),
    callRsiLo: numEnv("SIGNAL_CALL_RSI_LO", 50),
    callRsiHi: numEnv("SIGNAL_CALL_RSI_HI", 70),
    putRsiLo: numEnv("SIGNAL_PUT_RSI_LO", 30),
    putRsiHi: numEnv("SIGNAL_PUT_RSI_HI", 50),
    bbCallAbove: numEnv("SIGNAL_BB_CALL_MIN", 0.5),
    bbPutBelow: numEnv("SIGNAL_BB_PUT_MAX", 0.5),
  };
}

/** Safe to send to browser (no secrets). */
function getPublicStrategyParams() {
  const s = getSignalParams();
  const z = getScannerParams();
  return {
    version: 1,
    signal: s,
    scanner: {
      adxRegimeOffset: z.adxRegimeOffset,
      volSurgeMult: Number.isFinite(z.volSurgeMult) ? z.volSurgeMult : null,
      volSurgeAdxSubtract: z.volSurgeAdxSubtract,
      adxGateFloor: Number.isFinite(z.adxGateFloor) ? z.adxGateFloor : null,
      bearConfirmedRsiLo: z.bearConfirmedRsiLo,
      bearConfirmedRsiHi: z.bearConfirmedRsiHi,
      bearOversoldRsiMax: z.bearOversoldRsiMax,
      bearOversoldScoreBonus: z.bearOversoldScoreBonus,
      flushDayChangePct: Number.isFinite(z.flushDayChangePct)
        ? z.flushDayChangePct
        : null,
      flushVwapDistPct: Number.isFinite(z.flushVwapDistPct)
        ? z.flushVwapDistPct
        : null,
    },
  };
}

module.exports = {
  getScannerParams,
  getSignalParams,
  getPublicStrategyParams,
};
