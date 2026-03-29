function buildLevelsSummary(resistance, support, rrRatio, _price) {
  const lines = [];
  if (resistance) {
    lines.push(
      `Nearest resistance: $${resistance.price.toFixed(2)} (${resistance.label}, ${resistance.distancePct}% away)`
    );
  }
  if (support) {
    lines.push(
      `Nearest support: $${support.price.toFixed(2)} (${support.label}, ${Math.abs(+support.distancePct)}% below)`
    );
  }
  if (rrRatio) {
    lines.push(`Risk/Reward to nearest levels: ${rrRatio}:1`);
  }
  return lines.join("\n");
}

function calculateKeyLevels(dailyCandles, hourlyCandles, currentPrice) {
  void hourlyCandles;
  if (!dailyCandles?.length) return null;

  const price = +currentPrice || 0;
  const levels = [];

  if (dailyCandles.length >= 2) {
    const priorDay = dailyCandles[dailyCandles.length - 2];
    levels.push({
      price: priorDay.high,
      type: "resistance",
      label: "Prior Day High",
      strength: "major",
      timeframe: "daily",
    });
    levels.push({
      price: priorDay.low,
      type: "support",
      label: "Prior Day Low",
      strength: "major",
      timeframe: "daily",
    });
  }

  const weekCandles = dailyCandles.slice(-6, -1);
  if (weekCandles.length >= 4) {
    const weekHigh = Math.max(...weekCandles.map((c) => c.high));
    const weekLow = Math.min(...weekCandles.map((c) => c.low));
    levels.push({
      price: weekHigh,
      type: "resistance",
      label: "Prior Week High",
      strength: "major",
      timeframe: "weekly",
    });
    levels.push({
      price: weekLow,
      type: "support",
      label: "Prior Week Low",
      strength: "major",
      timeframe: "weekly",
    });
  }

  const closes = dailyCandles.map((c) => c.close);
  if (closes.length >= 20) {
    const sma20 =
      closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
    levels.push({
      price: sma20,
      type: sma20 < price ? "support" : "resistance",
      label: "20-Day SMA",
      strength: "moderate",
      timeframe: "daily",
    });
  }
  if (closes.length >= 50) {
    const sma50 =
      closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    levels.push({
      price: sma50,
      type: sma50 < price ? "support" : "resistance",
      label: "50-Day SMA",
      strength: "major",
      timeframe: "daily",
    });
  }
  if (closes.length >= 200) {
    const sma200 =
      closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
    levels.push({
      price: sma200,
      type: sma200 < price ? "support" : "resistance",
      label: "200-Day SMA",
      strength: "major",
      timeframe: "daily",
    });
  }

  const yearCandles = dailyCandles.slice(-252);
  if (yearCandles.length > 50) {
    const high52w = Math.max(...yearCandles.map((c) => c.high));
    const low52w = Math.min(...yearCandles.map((c) => c.low));
    levels.push({
      price: high52w,
      type: "resistance",
      label: "52-Week High",
      strength: "major",
      timeframe: "yearly",
      isExtreme: true,
    });
    levels.push({
      price: low52w,
      type: "support",
      label: "52-Week Low",
      strength: "major",
      timeframe: "yearly",
      isExtreme: true,
    });
  }

  const increment =
    price > 1000 ? 50
    : price > 500 ? 25
    : price > 100 ? 10
    : price > 50 ? 5
    : 1;
  const base = Math.round(price / increment) * increment;
  for (let i = -4; i <= 4; i++) {
    const roundNum = base + i * increment;
    if (roundNum > 0) {
      levels.push({
        price: roundNum,
        type: roundNum > price ? "resistance" : "support",
        label: `Round $${roundNum}`,
        strength: roundNum % (increment * 5) === 0 ? "major" : "minor",
        timeframe: "psychological",
      });
    }
  }

  const levelsWithDistance = levels.map((l) => ({
    ...l,
    distancePct: (((l.price - price) / price) * 100).toFixed(2),
    distanceAbs: Math.abs(l.price - price),
  }));

  levelsWithDistance.sort((a, b) => a.distanceAbs - b.distanceAbs);

  const nearestResistance = levelsWithDistance
    .filter(
      (l) => l.type === "resistance" && l.price > price * 1.001
    )
    .sort((a, b) => a.price - b.price)[0];

  const nearestSupport = levelsWithDistance
    .filter((l) => l.type === "support" && l.price < price * 0.999)
    .sort((a, b) => b.price - a.price)[0];

  const riskToSupport = nearestSupport
    ? ((price - nearestSupport.price) / price) * 100
    : null;
  const rewardToResistance = nearestResistance
    ? ((nearestResistance.price - price) / price) * 100
    : null;
  const riskRewardRatio =
    riskToSupport && rewardToResistance
      ? (rewardToResistance / riskToSupport).toFixed(2)
      : null;

  const nearResistanceWarning =
    nearestResistance && +nearestResistance.distancePct < 1.0
      ? `Only ${nearestResistance.distancePct}% to ${nearestResistance.label} at $${nearestResistance.price.toFixed(2)}. Consider waiting for break or target lower strike.`
      : null;

  const nearSupportWarning =
    nearestSupport && Math.abs(+nearestSupport.distancePct) < 1.0
      ? `Only ${Math.abs(+nearestSupport.distancePct)}% to ${nearestSupport.label} at $${nearestSupport.price.toFixed(2)}. Strong support — good for calls.`
      : null;

  return {
    allLevels: levelsWithDistance.slice(0, 15),
    nearestResistance,
    nearestSupport,
    riskToSupport,
    rewardToResistance,
    riskRewardRatio,
    nearResistanceWarning,
    nearSupportWarning,
    summary: buildLevelsSummary(
      nearestResistance,
      nearestSupport,
      riskRewardRatio,
      price
    ),
  };
}

module.exports = { calculateKeyLevels, buildLevelsSummary };
