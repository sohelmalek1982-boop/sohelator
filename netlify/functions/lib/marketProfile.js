function calculateMarketProfile(candles, lookbackDays = 5) {
  if (!candles || candles.length < 10) return null;

  const cutoff = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
  const recentCandles = candles.filter((c) => {
    const t = new Date(c.time).getTime();
    return !Number.isNaN(t) && t > cutoff;
  });

  if (recentCandles.length < 10) return null;

  const allHighs = recentCandles.map((c) => c.high);
  const allLows = recentCandles.map((c) => c.low);
  const priceHigh = Math.max(...allHighs);
  const priceLow = Math.min(...allLows);
  const priceRange = priceHigh - priceLow;
  const tickSize = priceRange / 50;
  if (tickSize <= 0) return null;

  const volumeProfile = {};

  for (const candle of recentCandles) {
    const candleHigh = candle.high;
    const candleLow = candle.low;
    const candleVol = candle.volume || 0;
    const candleRange = candleHigh - candleLow;
    if (candleRange <= 0) continue;
    const levels = Math.ceil(candleRange / tickSize);
    const volPerLevel = candleVol / levels;
    for (let i = 0; i <= levels; i++) {
      const priceLevel = candleLow + i * tickSize;
      const roundedLevel = Math.round(priceLevel / tickSize) * tickSize;
      const key = roundedLevel.toFixed(2);
      volumeProfile[key] = (volumeProfile[key] || 0) + volPerLevel;
    }
  }

  const sortedLevels = Object.entries(volumeProfile)
    .map(([price, vol]) => ({ price: +price, vol }))
    .sort((a, b) => a.price - b.price);

  if (!sortedLevels.length) return null;

  const poc = sortedLevels.reduce((max, l) =>
    l.vol > max.vol ? l : max
  , sortedLevels[0]);

  const totalVol = sortedLevels.reduce((s, l) => s + l.vol, 0);
  const valueAreaTarget = totalVol * 0.7;

  let vaVol = poc.vol;
  let vaLow = poc.price;
  let vaHigh = poc.price;
  let belowIdx = sortedLevels.indexOf(poc) - 1;
  let aboveIdx = sortedLevels.indexOf(poc) + 1;

  while (
    vaVol < valueAreaTarget &&
    (belowIdx >= 0 || aboveIdx < sortedLevels.length)
  ) {
    const addBelow = belowIdx >= 0 ? sortedLevels[belowIdx].vol : 0;
    const addAbove =
      aboveIdx < sortedLevels.length ? sortedLevels[aboveIdx].vol : 0;
    if (addAbove >= addBelow && addAbove > 0) {
      vaVol += addAbove;
      vaHigh = sortedLevels[aboveIdx].price;
      aboveIdx++;
    } else if (addBelow > 0) {
      vaVol += addBelow;
      vaLow = sortedLevels[belowIdx].price;
      belowIdx--;
    } else break;
  }

  const currentPrice = recentCandles[recentCandles.length - 1].close;

  let pricePosition;
  if (currentPrice > vaHigh * 1.002) pricePosition = "ABOVE_VALUE_AREA";
  else if (currentPrice < vaLow * 0.998) pricePosition = "BELOW_VALUE_AREA";
  else pricePosition = "IN_VALUE_AREA";

  const hvnThreshold = (totalVol / sortedLevels.length) * 2;
  const hvn = sortedLevels
    .filter((l) => l.vol > hvnThreshold)
    .map((l) => l.price);

  const lvnThreshold = (totalVol / sortedLevels.length) * 0.3;
  const lvn = sortedLevels
    .filter((l) => l.vol < lvnThreshold)
    .map((l) => l.price);

  const nearestHVNAbove = hvn
    .filter((x) => x > currentPrice)
    .sort((a, b) => a - b)[0];
  const nearestHVNBelow = hvn
    .filter((x) => x < currentPrice)
    .sort((a, b) => b - a)[0];

  const inLVN = lvn.some(
    (x) => Math.abs(x - currentPrice) < tickSize * 2
  );

  const interpretation =
    pricePosition === "ABOVE_VALUE_AREA"
      ? `Price above value area ($${vaHigh.toFixed(2)}). Bullish breakout territory. ${
          nearestHVNAbove
            ? `Next resistance: $${nearestHVNAbove.toFixed(2)}`
            : "Clear air above"
        }.`
      : pricePosition === "BELOW_VALUE_AREA"
        ? `Price below value area ($${vaLow.toFixed(2)}). Bearish breakdown territory. ${
            nearestHVNBelow
              ? `Next support: $${nearestHVNBelow.toFixed(2)}`
              : "Limited support below"
          }.`
        : `Price in value area ($${vaLow.toFixed(2)}-$${vaHigh.toFixed(2)}). Fair value zone — breakout direction TBD. Watch for break of VAH or VAL.`;

  return {
    poc: poc.price,
    vah: vaHigh,
    val: vaLow,
    valueAreaPct: ((vaVol / totalVol) * 100).toFixed(1),
    pricePosition,
    inLVN,
    interpretation,
    hvn: hvn.slice(0, 5),
    lvn: lvn.slice(0, 5),
    nearestHVNAbove,
    nearestHVNBelow,
    summary: `Market Profile: POC=$${poc.price.toFixed(2)}, VAH=$${vaHigh.toFixed(2)}, VAL=$${vaLow.toFixed(2)}. ${interpretation}`,
  };
}

function calculateSessionProfile(todayCandles) {
  if (!todayCandles || todayCandles.length < 3) return null;
  return calculateMarketProfile(todayCandles, 1);
}

module.exports = { calculateMarketProfile, calculateSessionProfile };
