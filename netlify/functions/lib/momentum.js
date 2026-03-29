const { calcRSI } = require("./indicatorsShared");

function buildMomentumInterpretation(
  bias,
  stochRSI,
  williams,
  cci,
  atrPct,
  volMom
) {
  const lines = [];
  lines.push(`Momentum bias: ${bias}`);
  lines.push(
    `StochRSI: K=${stochRSI.k} D=${stochRSI.d} (${
      stochRSI.k > 80 ? "overbought" : stochRSI.k < 20 ? "oversold" : "mid-range"
    })`
  );
  lines.push(
    `CCI: ${cci.toFixed(0)} (${
      cci > 100 ? "strong bull" : cci < -100 ? "strong bear" : "neutral"
    })`
  );
  lines.push(
    `ATR: ${atrPct}% (${atrPct > 3 ? "HIGH vol" : atrPct < 1 ? "LOW vol" : "normal vol"})`
  );
  if (volMom > 1.5) {
    lines.push(`Volume surging ${volMom.toFixed(1)}x average`);
  }
  return lines.join("\n");
}

function calculateAdvancedMomentum(candles, closes) {
  if (!candles?.length || !closes?.length || closes.length < 14) {
    return null;
  }

  function calcATR(c, period = 14) {
    if (c.length < period + 1) return 0;
    const trs = [];
    for (let i = 1; i < c.length; i++) {
      const h = c[i].high;
      const l = c[i].low;
      const pc = c[i - 1].close;
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    return trs.slice(-period).reduce((a, b) => a + b, 0) / period;
  }

  function calcStochRSI(closesArr, period = 14) {
    if (closesArr.length < period * 2 + 1) return { k: 50, d: 50 };
    const kSeries = [];
    for (let i = period; i < closesArr.length; i++) {
      const rsiVal = calcRSI(closesArr.slice(0, i + 1), period);
      const window = [];
      for (let j = period; j <= i; j++) {
        window.push(calcRSI(closesArr.slice(0, j + 1), period));
      }
      const recent = window.slice(-period);
      const maxRSI = Math.max(...recent);
      const minRSI = Math.min(...recent);
      const range = maxRSI - minRSI;
      const k = range > 0 ? ((rsiVal - minRSI) / range) * 100 : 50;
      kSeries.push(k);
    }
    if (!kSeries.length) return { k: 50, d: 50 };
    const k = kSeries[kSeries.length - 1];
    const dSlice = kSeries.slice(-3);
    const d = dSlice.reduce((a, b) => a + b, 0) / dSlice.length;
    return { k: +k.toFixed(1), d: +d.toFixed(1) };
  }

  function calcWilliamsR(c, period = 14) {
    if (c.length < period) return -50;
    const recent = c.slice(-period);
    const highestHigh = Math.max(...recent.map((x) => x.high));
    const lowestLow = Math.min(...recent.map((x) => x.low));
    const close = closes[closes.length - 1];
    if (highestHigh === lowestLow) return -50;
    return ((highestHigh - close) / (highestHigh - lowestLow)) * -100;
  }

  function calcCCI(c, period = 20) {
    if (c.length < period) return 0;
    const recent = c.slice(-period);
    const tps = recent.map((x) => (x.high + x.low + x.close) / 3);
    const avgTP = tps.reduce((a, b) => a + b, 0) / period;
    const meanDev =
      tps.reduce((s, tp) => s + Math.abs(tp - avgTP), 0) / period;
    if (meanDev === 0) return 0;
    return (tps[tps.length - 1] - avgTP) / (0.015 * meanDev);
  }

  function calcROC(closesArr, period = 10) {
    if (closesArr.length < period + 1) return 0;
    const current = closesArr[closesArr.length - 1];
    const past = closesArr[closesArr.length - 1 - period];
    return past > 0 ? ((current - past) / past) * 100 : 0;
  }

  function calcOBVTrend(c) {
    if (c.length < 5) return "flat";
    let obv = 0;
    const obvValues = [0];
    for (let i = 1; i < c.length; i++) {
      if (c[i].close > c[i - 1].close) obv += c[i].volume || 0;
      else if (c[i].close < c[i - 1].close) obv -= c[i].volume || 0;
      obvValues.push(obv);
    }
    const recent = obvValues.slice(-5);
    const slope = (recent[4] - recent[0]) / 4;
    if (slope > 0) return "rising";
    if (slope < 0) return "falling";
    return "flat";
  }

  function calcVolMomentum(c) {
    if (c.length < 20) return 1;
    const recent5Vol =
      c.slice(-5).reduce((s, x) => s + (x.volume || 0), 0) / 5;
    const avg20Vol =
      c.slice(-20).reduce((s, x) => s + (x.volume || 0), 0) / 20;
    return avg20Vol > 0 ? recent5Vol / avg20Vol : 1;
  }

  function calcPriceMomentum(c) {
    if (c.length < 10) return 0;
    const changes = [];
    for (let i = 1; i < c.length; i++) {
      changes.push(
        ((c[i] - c[i - 1]) / c[i - 1]) * 100
      );
    }
    return changes.slice(-5).reduce((a, b) => a + b, 0) / 5;
  }

  const atr = calcATR(
    candles.map((x) => ({
      high: x.high,
      low: x.low,
      close: x.close,
    }))
  );
  const stochRSI = calcStochRSI(closes, 14);
  const williamsR = calcWilliamsR(candles, 14);
  const cci = calcCCI(candles, 20);
  const roc10 = calcROC(closes, 10);
  const roc5 = calcROC(closes, 5);
  const obvTrend = calcOBVTrend(candles);
  const volMomentum = calcVolMomentum(candles);
  const priceMomentum = calcPriceMomentum(closes);

  const currentPrice = closes[closes.length - 1];
  const atrPct = currentPrice > 0 ? ((atr / currentPrice) * 100).toFixed(2) : "0";

  let momentumScore = 50;
  if (stochRSI.k > 80) momentumScore += 15;
  else if (stochRSI.k > 60) momentumScore += 8;
  else if (stochRSI.k < 20) momentumScore -= 15;
  else if (stochRSI.k < 40) momentumScore -= 8;

  if (williamsR > -20) momentumScore += 10;
  else if (williamsR < -80) momentumScore -= 10;

  if (cci > 100) momentumScore += 10;
  else if (cci < -100) momentumScore -= 10;

  if (roc5 > 1) momentumScore += 10;
  else if (roc5 < -1) momentumScore -= 10;

  if (obvTrend === "rising") momentumScore += 5;
  else if (obvTrend === "falling") momentumScore -= 5;

  if (volMomentum > 1.5) momentumScore += 5;

  momentumScore = Math.max(0, Math.min(100, momentumScore));
  const momentumBias =
    momentumScore > 65 ? "BULLISH" : momentumScore < 35 ? "BEARISH" : "NEUTRAL";

  const expectedMoveUp = currentPrice + atr;
  const expectedMoveDown = currentPrice - atr;

  return {
    atr: +atr.toFixed(2),
    atrPct,
    stochRSI,
    williamsR: +williamsR.toFixed(1),
    cci: +cci.toFixed(1),
    roc5: +roc5.toFixed(2),
    roc10: +roc10.toFixed(2),
    obvTrend,
    volMomentum: +volMomentum.toFixed(2),
    priceMomentum: +priceMomentum.toFixed(3),
    momentumScore,
    momentumBias,
    expectedMoveUp: +expectedMoveUp.toFixed(2),
    expectedMoveDown: +expectedMoveDown.toFixed(2),
    expectedMovePct: +atrPct,
    optimalCallStrike: +(currentPrice + atr * 0.8).toFixed(0),
    optimalPutStrike: +(currentPrice - atr * 0.8).toFixed(0),
    interpretation: buildMomentumInterpretation(
      momentumBias,
      stochRSI,
      williamsR,
      cci,
      +atrPct,
      volMomentum
    ),
  };
}

module.exports = { calculateAdvancedMomentum, buildMomentumInterpretation };
