function predictSetup(currentInds, prevInds3, prevInds6) {
  if (!currentInds || !prevInds3 || !prevInds6) return [];

  const predictions = [];
  const curAdx = Number(currentInds.adx);
  const p3Adx = Number(prevInds3.adx);
  const p6Adx = Number(prevInds6.adx);
  const curMacd = Number(currentInds.macd);
  const p3Macd = Number(prevInds3.macd);
  const p6Macd = Number(prevInds6.macd);
  const curRsi = Number(currentInds.rsi);
  const p3Rsi = Number(prevInds3.rsi);
  const p6Rsi = Number(prevInds6.rsi);
  const curVd = Number(currentInds.vwapDist);
  const p6Vd = Number(prevInds6.vwapDist);

  const adxVelocity = curAdx - p3Adx;
  const adxAccel = adxVelocity - (p3Adx - p6Adx);

  const macdApproachingPositive =
    p6Macd < 0 &&
    p3Macd > p6Macd &&
    curMacd > p3Macd &&
    curMacd < 0.05;

  const macdApproachingNegative =
    p6Macd > 0 &&
    p3Macd < p6Macd &&
    curMacd < p3Macd &&
    curMacd > -0.05;

  const rsiApproaching50Bull =
    p6Rsi < 48 &&
    curRsi > p6Rsi &&
    curRsi > 46 &&
    curRsi < 52;

  const rsiApproaching50Bear =
    p6Rsi > 52 &&
    curRsi < p6Rsi &&
    curRsi < 54 &&
    curRsi > 48;

  const approachingVWAPFromBelow =
    p6Vd < -0.5 &&
    curVd > p6Vd &&
    curVd > -0.2;

  const approachingVWAPFromAbove =
    p6Vd > 0.5 &&
    curVd < p6Vd &&
    curVd < 0.2;

  const adxBuilding =
    p6Adx < 20 && curAdx > 18 && adxVelocity > 0 && adxAccel > 0;

  const bullSignals = [
    adxBuilding,
    macdApproachingPositive,
    rsiApproaching50Bull,
    approachingVWAPFromBelow,
    adxVelocity > 1.5,
  ].filter(Boolean).length;

  if (bullSignals >= 3) {
    const minsToConfirm = Math.round((5 - bullSignals) * 5 + 5);
    predictions.push({
      type: "bull_incoming",
      confidence: Math.min(95, 50 + bullSignals * 12),
      minsToConfirm,
      signals: bullSignals,
      message:
        `Bull setup forming — ${bullSignals}/5 conditions building. Likely confirms in ~${minsToConfirm} min. Get your order ready.`,
      action: "GET READY — DO NOT BUY YET",
      emoji: "🔔",
    });
  }

  const bearSignals = [
    adxBuilding,
    macdApproachingNegative,
    rsiApproaching50Bear,
    approachingVWAPFromAbove,
    adxVelocity > 1.5,
  ].filter(Boolean).length;

  if (bearSignals >= 3) {
    const minsToConfirm = Math.round((5 - bearSignals) * 5 + 5);
    predictions.push({
      type: "bear_incoming",
      confidence: Math.min(95, 50 + bearSignals * 12),
      minsToConfirm,
      signals: bearSignals,
      message: `Bear setup forming — ${bearSignals}/5 conditions building. Likely confirms in ~${minsToConfirm} min.`,
      action: "GET READY — WATCH FOR PUT ENTRY",
      emoji: "🔔",
    });
  }

  const macdSlope = Number(currentInds.macdSlope) || 0;
  if (curRsi > 65 && macdSlope < 0 && p3Rsi > p6Rsi) {
    predictions.push({
      type: "reversal_warning",
      confidence: Math.min(85, 40 + (curRsi - 65) * 3),
      minsToConfirm: 10,
      message: `RSI at ${curRsi.toFixed(1)} and MACD slowing. Reversal risk building. Tighten stop if in calls.`,
      action: "TIGHTEN STOP PREEMPTIVELY",
      emoji: "⚠️",
    });
  }

  return predictions;
}

function calculateRetestEntry(currentPrice, vwap, direction, atr) {
  const price = Number(currentPrice);
  const vw = Number(vwap);
  if (!price || !vw) {
    return { shouldWait: false, message: "Entry now is fine." };
  }

  if (direction === "bull") {
    const retestLevel = vw * 1.001;
    const currentDistFromVwap = ((price - vw) / vw) * 100;
    if (currentDistFromVwap > 0.5) {
      return {
        shouldWait: true,
        retestPrice: retestLevel,
        currentPrice: price,
        savings: (((price - retestLevel) / price) * 100).toFixed(2),
        message: `Price is ${currentDistFromVwap.toFixed(2)}% above VWAP. Wait for pullback to $${retestLevel.toFixed(2)} for better entry.`,
      };
    }
  }

  if (direction === "bear") {
    const retestLevel = vw * 0.999;
    const currentDistFromVwap = ((vw - price) / vw) * 100;
    if (currentDistFromVwap > 0.5) {
      return {
        shouldWait: true,
        retestPrice: retestLevel,
        currentPrice: price,
        message: `Price is ${currentDistFromVwap.toFixed(2)}% below VWAP. Bounce toward $${retestLevel.toFixed(2)} can offer better put entry.`,
      };
    }
  }

  return { shouldWait: false, message: "Entry now is fine." };
}

module.exports = { predictSetup, calculateRetestEntry };
