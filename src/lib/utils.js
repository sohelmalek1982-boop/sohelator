/**
 * SOHELATOR blueprint — shared helpers for scanner libs (src/lib).
 * Pure utilities: lists, dates, TA primitives, candle parsing.
 */

/** @param {unknown} x */
export function normList(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/** @param {unknown} x @param {number} fallback */
export function num(x, fallback = 0) {
  const n = parseFloat(String(x));
  return Number.isFinite(n) ? n : fallback;
}

/** @param {number} v @param {number} lo @param {number} hi */
export function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * @param {string | Date} d
 * @returns {string} YYYY-MM-DD
 */
export function toYmd(d = new Date()) {
  const x = typeof d === "string" ? new Date(d) : d;
  return x.toISOString().slice(0, 10);
}

/**
 * @param {number} daysAgo
 * @returns {string} YYYY-MM-DD
 */
export function daysAgoYmd(daysAgo) {
  const t = Date.now() - daysAgo * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

/** Tradier timesales series → normalized OHLCV bars */
export function parseTimesalesRows(seriesData) {
  const rows = normList(seriesData);
  return rows
    .map((c) => ({
      time: c.time || c.timestamp,
      open: num(c.open),
      high: num(c.high),
      low: num(c.low),
      close: num(c.close),
      volume: num(c.volume ?? c.volum),
    }))
    .filter((x) => !Number.isNaN(x.close));
}

/** Tradier daily history.day → bars */
export function parseHistoryDays(dayField) {
  const arr = Array.isArray(dayField) ? dayField : dayField ? [dayField] : [];
  return arr
    .map((d) => ({
      time: d.date,
      open: num(d.open),
      high: num(d.high),
      low: num(d.low),
      close: num(d.close),
      volume: num(d.volume),
    }))
    .filter((c) => !Number.isNaN(c.close));
}

/** Wilder-style RSI (matches indicatorsShared-style inputs) */
export function calcRSI(closes, period = 14) {
  if (!closes?.length || closes.length < period + 1) return 50;
  const sl = closes.slice(-(period + 1));
  let g = 0;
  let l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  const ag = g / period;
  const al = l / period;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

/** ADX on { high, low, close } candles */
export function calcADX(candles, period = 14) {
  if (!candles?.length || candles.length < period + 2) return 15;
  const sl = candles.slice(-(period + 1));
  let pdm = 0;
  let ndm = 0;
  let tr = 0;
  for (let i = 1; i < sl.length; i++) {
    const h = sl[i].high;
    const low = sl[i].low;
    const ph = sl[i - 1].high;
    const pl = sl[i - 1].low;
    const pc = sl[i - 1].close;
    const um = h - ph;
    const dm = pl - low;
    pdm += um > dm && um > 0 ? um : 0;
    ndm += dm > um && dm > 0 ? dm : 0;
    tr += Math.max(h - low, Math.abs(h - pc), Math.abs(low - pc));
  }
  if (!tr) return 15;
  const pdi = (pdm / tr) * 100;
  const ndi = (ndm / tr) * 100;
  const s = pdi + ndi;
  return s > 0 ? (Math.abs(pdi - ndi) / s) * 100 : 15;
}

/** MACD histogram (last bar) */
export function calcMACDHist(closes) {
  if (!closes?.length || closes.length < 35) return 0;
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;
  let e12 = closes[0];
  let e26 = closes[0];
  const ml = [];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) ml.push(e12 - e26);
  }
  if (!ml.length) return 0;
  let sig = ml[0];
  for (let i = 1; i < ml.length; i++) {
    sig = ml[i] * k9 + sig * (1 - k9);
  }
  return ml[ml.length - 1] - sig;
}

/**
 * Higher-timeframe trend from daily closes: "up" | "down" | "neutral"
 * @param {number[]} dailyCloses
 */
export function dailyTrend(dailyCloses) {
  if (!dailyCloses?.length || dailyCloses.length < 5) return "neutral";
  const a = dailyCloses[dailyCloses.length - 1];
  const b = dailyCloses[Math.max(0, dailyCloses.length - 6)];
  const pct = b !== 0 ? ((a - b) / b) * 100 : 0;
  if (pct > 1.5) return "up";
  if (pct < -1.5) return "down";
  return "neutral";
}
