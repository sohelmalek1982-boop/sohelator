const { tradierGet, normList } = require("./tradierClient");
const {
  calcADX,
  calcMACD,
  calcRSI,
  calcEMA,
  calcVWAP,
} = require("./indicatorsShared");

function parseHistoryDays(dayField) {
  const arr = Array.isArray(dayField) ? dayField : dayField ? [dayField] : [];
  return arr
    .map((d) => ({
      time: d.date,
      open: +d.open,
      high: +d.high,
      low: +d.low,
      close: +d.close,
      volume: +(d.volume || 0),
    }))
    .filter((c) => !Number.isNaN(c.close));
}

function parseTimesales(seriesData) {
  const rows = normList(seriesData);
  return rows
    .map((c) => ({
      time: c.time || c.timestamp,
      open: +c.open,
      high: +c.high,
      low: +c.low,
      close: +c.close,
      volume: +(c.volume || c.volum || 0),
    }))
    .filter((x) => !Number.isNaN(x.close));
}

function buildNCandles(candles, n) {
  if (!candles?.length || n < 1) return [];
  const result = [];
  for (let i = 0; i < candles.length; i += n) {
    const group = candles.slice(i, i + n);
    if (!group.length) continue;
    result.push({
      time: group[0].time,
      open: group[0].open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return result;
}

function analyzeTimeframe(candles, label) {
  if (!candles || candles.length < 5) {
    return {
      label,
      trend: "NEUTRAL",
      adx: 15,
      rsi: 50,
      macd: 0,
      vwap: 0,
    };
  }

  const closes = candles.map((c) => c.close);
  const adxCandles = candles.map((c) => ({
    high: c.high,
    low: c.low,
    close: c.close,
  }));
  const adx = calcADX(adxCandles, 14);
  const macd = calcMACD(closes);
  const rsi = calcRSI(closes, 14);
  const ema8 = calcEMA(closes, 8);
  const ema21 = calcEMA(closes, 21);
  const ema50 =
    closes.length >= 50
      ? calcEMA(closes, 50)
      : calcEMA(closes, Math.max(5, closes.length - 1));
  const vwap = calcVWAP(candles);
  const currentPrice = closes[closes.length - 1];

  let trend = "NEUTRAL";
  let trendScore = 0;
  if (currentPrice > ema8) trendScore++;
  if (ema8 > ema21) trendScore++;
  if (currentPrice > ema21) trendScore++;
  if (macd.hist > 0) trendScore++;
  if (rsi > 50) trendScore++;
  if (adx > 20) trendScore++;
  if (trendScore >= 5) trend = "BULL";
  else if (trendScore <= 1) trend = "BEAR";

  return {
    label,
    trend,
    adx,
    rsi,
    macd: macd.hist,
    macdDir: macd.hist > 0 ? "positive" : "negative",
    ema8,
    ema21,
    ema50,
    vwap,
    currentPrice,
    aboveVWAP: currentPrice > vwap,
    aboveEma8: currentPrice > ema8,
    aboveEma21: currentPrice > ema21,
    aboveEma50: currentPrice > ema50,
    trendScore,
    strength:
      adx > 30 ? "STRONG" : adx > 25 ? "MODERATE" : adx > 20 ? "WEAK" : "NONE",
  };
}

async function getFullTimeframeAnalysis(symbol) {
  const today = new Date();
  const endStr = today.toISOString().split("T")[0];
  const sixtyDaysAgo = new Date(today - 60 * 86400000)
    .toISOString()
    .split("T")[0];
  const tenDaysAgo = new Date(today - 10 * 86400000)
    .toISOString()
    .split("T")[0];

  const [dailyData, fiveMinData] = await Promise.all([
    tradierGet("/v1/markets/history", {
      symbol,
      interval: "daily",
      start: sixtyDaysAgo,
      end: endStr,
    }),
    tradierGet("/v1/markets/timesales", {
      symbol,
      interval: "5min",
      start: tenDaysAgo,
      end: endStr,
      session_filter: "open",
    }),
  ]);

  const daily = parseHistoryDays(dailyData.history?.day);
  const fiveMin = parseTimesales(fiveMinData.series?.data);
  const hourly = buildNCandles(fiveMin, 12);
  const fourHour = buildNCandles(hourly, 4);
  const fifteenMin = buildNCandles(fiveMin, 3);

  const analyses = {
    daily: analyzeTimeframe(daily, "daily"),
    fourHour: analyzeTimeframe(fourHour, "4H"),
    oneHour: analyzeTimeframe(hourly, "1H"),
    fifteenMin: analyzeTimeframe(fifteenMin, "15M"),
    fiveMin: analyzeTimeframe(fiveMin, "5M"),
  };

  const bullCount = Object.values(analyses).filter(
    (a) => a.trend === "BULL"
  ).length;
  const bearCount = Object.values(analyses).filter(
    (a) => a.trend === "BEAR"
  ).length;

  const weightedBull =
    (analyses.daily.trend === "BULL" ? 3 : 0) +
    (analyses.fourHour.trend === "BULL" ? 2 : 0) +
    (analyses.oneHour.trend === "BULL" ? 1.5 : 0) +
    (analyses.fifteenMin.trend === "BULL" ? 1 : 0) +
    (analyses.fiveMin.trend === "BULL" ? 0.5 : 0);

  const weightedBear =
    (analyses.daily.trend === "BEAR" ? 3 : 0) +
    (analyses.fourHour.trend === "BEAR" ? 2 : 0) +
    (analyses.oneHour.trend === "BEAR" ? 1.5 : 0) +
    (analyses.fifteenMin.trend === "BEAR" ? 1 : 0) +
    (analyses.fiveMin.trend === "BEAR" ? 0.5 : 0);

  const maxWeight = 8;
  const alignmentScore =
    weightedBull > weightedBear
      ? Math.round((weightedBull / maxWeight) * 100)
      : Math.round((weightedBear / maxWeight) * 100);

  return {
    ...analyses,
    rawDaily: daily,
    rawHourly: hourly,
    rawFiveMin: fiveMin,
    bullCount,
    bearCount,
    weightedBull,
    weightedBear,
    alignmentScore,
    primaryTrend: analyses.daily.trend,
    tradingBias:
      weightedBull > weightedBear
        ? "BULL"
        : weightedBear > weightedBull
          ? "BEAR"
          : "NEUTRAL",
    confluenceLevel:
      alignmentScore >= 80 ? "HIGH" : alignmentScore >= 60 ? "MEDIUM" : "LOW",
  };
}

module.exports = {
  getFullTimeframeAnalysis,
  analyzeTimeframe,
  buildNCandles,
  parseHistoryDays,
  parseTimesales,
};
