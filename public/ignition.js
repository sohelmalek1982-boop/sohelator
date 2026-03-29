/**
 * Three-engine ignition (browser) — keep in sync with netlify/functions/lib/ignition.js
 */
function calculateIgnition(candles, indicators) {
  if (!candles || candles.length < 5) return null;

  const closes = candles.map((c) => c.close);
  const opens = candles.map((c) => c.open || c.close);
  const vols = candles.map((c) => c.volume || c.vol || 0);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const len = candles.length;
  const cur = len - 1;
  const prev = len - 2;
  const prev2 = len - 3;

  const candleRanges = candles.slice(-6, -1).map((c) => Math.abs(c.high - c.low));
  const avgRange =
    candleRanges.length > 0 ? candleRanges.reduce((a, b) => a + b, 0) / candleRanges.length : 1;
  const currentRange = Math.abs(highs[cur] - lows[cur]);
  const priceAccelRatio = avgRange > 0 ? currentRange / avgRange : 1;

  const candleDirectional = Math.abs(closes[cur] - opens[cur]) > currentRange * 0.4;

  const priceUp = closes[cur] > opens[cur];
  const prevPriceUp = closes[prev] > opens[prev];
  const consistent = priceUp === prevPriceUp;

  let priceScore = 0;
  if (priceAccelRatio >= 2.5) priceScore = 95;
  else if (priceAccelRatio >= 2.0) priceScore = 85;
  else if (priceAccelRatio >= 1.5) priceScore = 70;
  else if (priceAccelRatio >= 1.2) priceScore = 50;
  else if (priceAccelRatio >= 0.9) priceScore = 30;
  else priceScore = 10;

  if (candleDirectional) priceScore += 5;
  if (consistent) priceScore += 5;
  priceScore = Math.min(100, priceScore);

  const macd = indicators?.macd || 0;
  const macdPrev = indicators?.macdPrev || 0;
  const macdPrev2 = indicators?.macdPrev2 || 0;
  const rsi = indicators?.rsi || 50;
  const rsiPrev = indicators?.rsiPrev || 50;
  const adx = indicators?.adx || 15;
  const adxPrev = indicators?.adxPrev || 15;

  const macdExpanding1 = Math.abs(macd) > Math.abs(macdPrev);
  const macdExpanding2 = Math.abs(macdPrev) > Math.abs(macdPrev2);
  const macdExpandingStreak = macdExpanding1 && macdExpanding2 ? 2 : macdExpanding1 ? 1 : 0;

  const rsiVelocity = Math.abs(rsi - rsiPrev);

  const adxRisingFromLow = adxPrev < 22 && adx > adxPrev;
  const adxConfirmed = adx >= 25;

  let momScore = 0;

  if (macdExpandingStreak >= 2) momScore += 40;
  else if (macdExpandingStreak >= 1) momScore += 20;

  const macdAligned = (macd > 0 && priceUp) || (macd < 0 && !priceUp);
  if (macdAligned) momScore += 15;

  if (priceUp && rsi >= 50 && rsi <= 70) {
    momScore += 20;
    if (rsiVelocity >= 2) momScore += 10;
  } else if (!priceUp && rsi >= 30 && rsi <= 50) {
    momScore += 20;
    if (rsiVelocity >= 2) momScore += 10;
  }

  if (adxConfirmed) momScore += 15;
  else if (adxRisingFromLow) momScore += 8;

  momScore = Math.min(100, momScore);

  const recentVols = vols.slice(-6, -1).filter((v) => v > 0);
  const recentVolAvg =
    recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;

  const currentVol = vols[cur];
  const prevVol = vols[prev] || 0;
  const prev2Vol = vols[prev2] || 0;

  const volRatio = recentVolAvg > 0 ? currentVol / recentVolAvg : 1;

  const volExpanding1 = currentVol > prevVol * 1.15;
  const volExpanding2 = prevVol > prev2Vol * 1.1;
  const volExpandingStreak = volExpanding1 && volExpanding2 ? 2 : volExpanding1 ? 1 : 0;

  const volConfirming =
    (priceUp && currentVol > recentVolAvg) || (!priceUp && currentVol > recentVolAvg);

  let volScore = 0;
  if (volRatio >= 3.0) volScore = 95;
  else if (volRatio >= 2.0) volScore = 80;
  else if (volRatio >= 1.5) volScore = 60;
  else if (volRatio >= 1.2) volScore = 40;
  else volScore = 15;

  if (volExpandingStreak >= 2) volScore += 15;
  else if (volExpandingStreak >= 1) volScore += 8;
  if (volConfirming) volScore += 5;
  volScore = Math.min(100, volScore);

  const ignitionScore = Math.round(priceScore * 0.28 + momScore * 0.36 + volScore * 0.36);

  const direction = priceUp ? "BULL" : "BEAR";

  let status;
  let statusColor;
  let description;
  let action;

  if (ignitionScore >= 80) {
    status = "LAUNCH";
    statusColor = "#00ff87";
    description =
      `All 3 engines firing. ` +
      `Price accelerating ${priceAccelRatio.toFixed(1)}x. ` +
      `Volume ${volRatio.toFixed(1)}x recent. ` +
      `MACD expanding ${macdExpandingStreak} bars. ` +
      `This move is real — not a head-fake.`;
    action = direction === "BULL" ? "BUY CALLS NOW — move confirmed" : "BUY PUTS NOW — move confirmed";
  } else if (ignitionScore >= 65) {
    status = "IGNITING";
    statusColor = "#ffd700";
    description =
      `2 of 3 engines firing. ` +
      `Move building but not fully confirmed. ` +
      `Get your order ready. ` +
      `Wait for ${
        volScore < 65 ? "volume to surge" : momScore < 65 ? "MACD to expand one more bar" : "price to accelerate"
      } for full launch.`;
    action = "GET ORDER READY — entry soon";
  } else if (ignitionScore >= 45) {
    status = "WARMING UP";
    statusColor = "#ff8c42";
    description =
      `1 engine starting. ` +
      `No entry yet — setup phase only. ` +
      `Watch for 2+ engines to fire together.`;
    action = "WATCH — not ready yet";
  } else {
    status = "COLD";
    statusColor = "#4a6070";
    description =
      `No engines firing. ` +
      `Volume flat, momentum flat, ` +
      `price not accelerating. ` +
      `Chop — any premium bought here ` +
      `will decay to zero.`;
    action = "STAND ASIDE — paying theta for nothing";
  }

  const last8 = candles.slice(-8);
  const maxVol8 = Math.max(...last8.map((c) => c.volume || c.vol || 0), 1);
  const barData = last8.map((c, i) => ({
    heightPct: Math.round(((c.volume || c.vol || 0) / maxVol8) * 100),
    isUp: (c.close || 0) >= (c.open || c.close || 0),
    isCurrent: i === last8.length - 1,
    ratio: recentVolAvg > 0 ? ((c.volume || c.vol || 0) / recentVolAvg).toFixed(1) : "1.0",
  }));

  return {
    ignitionScore,
    status,
    statusColor,
    direction,
    description,
    action,
    engines: {
      price: {
        score: priceScore,
        ratio: priceAccelRatio.toFixed(1),
        status: priceScore >= 75 ? "FIRING" : priceScore >= 50 ? "BUILDING" : "COLD",
      },
      momentum: {
        score: momScore,
        expandingBars: macdExpandingStreak,
        rsiVelocity: rsiVelocity.toFixed(1),
        adx: adx.toFixed(1),
        status: momScore >= 75 ? "FIRING" : momScore >= 50 ? "BUILDING" : "COLD",
      },
      volume: {
        score: volScore,
        ratio: volRatio.toFixed(1),
        expandingBars: volExpandingStreak,
        status: volScore >= 75 ? "FIRING" : volScore >= 50 ? "BUILDING" : "COLD",
      },
    },
    barData,
  };
}

window.calculateIgnition = calculateIgnition;
