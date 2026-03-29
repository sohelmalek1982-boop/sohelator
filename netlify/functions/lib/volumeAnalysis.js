/**
 * Volume / price–volume analysis for candles (5m or any OHLCV series).
 * Normalizes { volume | vol | v } and { high, low, close } field names.
 */

function normalizeCandle(c) {
  if (!c) return null;
  const high = +(c.high ?? c.h);
  const low = +(c.low ?? c.l);
  const close = +(c.close ?? c.c);
  const volume = Math.max(1, +(c.volume ?? c.vol ?? c.v ?? 0));
  if (Number.isNaN(close)) return null;
  return { high, low, close, volume };
}

function normalizeCandles(candles) {
  if (!candles || !candles.length) return [];
  return candles.map(normalizeCandle).filter(Boolean);
}

function analyzeVolume(candles, _quote) {
  const norm = normalizeCandles(candles);
  if (!norm || norm.length < 5) return null;

  const volumes = norm.map((c) => c.volume);
  const closes = norm.map((c) => c.close);
  const highs = norm.map((c) => c.high);

  const n = norm.length;
  const take = Math.min(20, n);
  const avg20 =
    volumes.slice(-take).reduce((a, b) => a + b, 0) / take;

  const lastCandle = norm[norm.length - 1];
  const last3Avg = volumes.slice(-3).reduce((a, b) => a + b, 0) / 3;
  const last5Avg = volumes.slice(-5).reduce((a, b) => a + b, 0) / 5;

  const currentVolRatio = avg20 > 0 ? lastCandle.volume / avg20 : 1;
  const recentVolRatio = avg20 > 0 ? last3Avg / avg20 : 1;

  const vol5 = volumes.slice(-5);
  const volSlope =
    vol5.length >= 3 && vol5[0] > 0
      ? (vol5[vol5.length - 1] - vol5[0]) / vol5[0]
      : 0;
  const volumeTrend =
    volSlope > 0.1 ? "RISING" : volSlope < -0.1 ? "FALLING" : "FLAT";

  const priceChange =
    closes.length >= 2 ? closes[closes.length - 1] - closes[closes.length - 2] : 0;
  const priceUp = priceChange > 0;
  const volUp = currentVolRatio > 1.2;

  let priceVolumeSignal;
  let priceVolumeInterpretation;

  if (priceUp && volUp) {
    priceVolumeSignal = "BULLISH CONFIRMATION";
    priceVolumeInterpretation =
      `Price rising on ${currentVolRatio.toFixed(1)}x ` +
      `volume. Real institutional buying. ` +
      `This move has conviction behind it.`;
  } else if (priceUp && !volUp) {
    priceVolumeSignal = "WEAK MOVE";
    priceVolumeInterpretation =
      `Price rising but volume is below average. ` +
      `No institutional conviction. ` +
      `This move may fade — watch closely.`;
  } else if (!priceUp && volUp) {
    priceVolumeSignal = "BEARISH CONFIRMATION";
    priceVolumeInterpretation =
      `Price dropping on ${currentVolRatio.toFixed(1)}x ` +
      `volume. Real selling pressure. ` +
      `Calls are at risk — tighten stop.`;
  } else {
    priceVolumeSignal = "WEAK SELLING";
    priceVolumeInterpretation =
      `Price dipping but volume is light. ` +
      `No real conviction behind the drop. ` +
      `Likely a normal pullback in a bull trend.`;
  }

  const isSurge = currentVolRatio >= 2.0;
  const isMegaSurge = currentVolRatio >= 4.0;

  const recentHighs = highs.slice(-10);
  const maxHigh = recentHighs.length ? Math.max(...recentHighs) : 0;
  const allTimeHighInWindow =
    maxHigh > 0 && closes[closes.length - 1] >= maxHigh * 0.995;
  const isClimaxVolume = isMegaSurge && allTimeHighInWindow;

  const midSlice = closes.length >= 10 ? closes.slice(-10, -3) : closes.slice(0, Math.max(0, closes.length - 3));
  const prevHigh = midSlice.length ? Math.max(...midSlice) : closes[0];
  const isPullback =
    closes.length >= 5 && closes[closes.length - 1] < prevHigh * 0.99;
  const isVolumeDryUp = isPullback && currentVolRatio < 0.6;

  const last5Closes = closes.slice(-5);
  const last5Vols = volumes.slice(-5);
  const priceHigherHighs =
    last5Closes.length >= 5 && last5Closes[4] > last5Closes[0];
  const volumeLowerHighs =
    last5Vols.length >= 5 && last5Vols[4] < last5Vols[0] * 0.8;
  const hasVolumeDivergence = priceHigherHighs && volumeLowerHighs;

  let pvSum = 0;
  let vSum = 0;
  for (const c of norm) {
    const tp = (c.high + c.low + c.close) / 3;
    pvSum += tp * (c.volume || 1);
    vSum += c.volume || 1;
  }
  const vwap = vSum > 0 ? pvSum / vSum : 0;
  const currentPrice = closes[closes.length - 1];
  const aboveVWAP = currentPrice > vwap;

  const prevPrice = closes.length >= 2 ? closes[closes.length - 2] : currentPrice;
  const justCrossedVWAPUp = prevPrice < vwap && currentPrice >= vwap;
  const justCrossedVWAPDown = prevPrice > vwap && currentPrice <= vwap;

  const vwapCrossVolume =
    (justCrossedVWAPUp || justCrossedVWAPDown) && currentVolRatio >= 1.5;

  let volumeScore = 50;
  if (isSurge && priceUp) volumeScore += 25;
  if (isSurge && !priceUp) volumeScore -= 25;
  if (isVolumeDryUp && aboveVWAP) volumeScore += 15;
  if (hasVolumeDivergence) volumeScore -= 20;
  if (isClimaxVolume) volumeScore -= 15;
  if (vwapCrossVolume && aboveVWAP) volumeScore += 20;
  if (volumeTrend === "RISING" && priceUp) volumeScore += 10;
  if (volumeTrend === "FALLING" && priceUp) volumeScore -= 10;
  volumeScore = Math.max(0, Math.min(100, volumeScore));

  const alerts = [];

  if (isMegaSurge && priceUp) {
    alerts.push({
      type: "SURGE_BULL",
      urgency: "HIGH",
      message:
        `🔥 Volume SURGE — ` +
        `${currentVolRatio.toFixed(1)}x average. ` +
        `Institutions buying hard. Strong confirmation.`,
      action: "ENTER OR ADD — high conviction move",
    });
  }

  if (isMegaSurge && !priceUp) {
    alerts.push({
      type: "SURGE_BEAR",
      urgency: "HIGH",
      message:
        `🚨 Volume SURGE on DOWN move — ` +
        `${currentVolRatio.toFixed(1)}x average. ` +
        `Real selling pressure detected.`,
      action: "EXIT CALLS — institutions selling",
    });
  }

  if (isClimaxVolume) {
    alerts.push({
      type: "CLIMAX",
      urgency: "HIGH",
      message:
        `⚠️ CLIMAX VOLUME at price high — ` +
        `massive volume at the top often signals ` +
        `everyone who wanted to buy has bought.`,
      action: "TAKE PROFITS — potential exhaustion",
    });
  }

  if (isVolumeDryUp) {
    alerts.push({
      type: "DRY_UP",
      urgency: "MEDIUM",
      message:
        `👀 Volume dry-up on pullback — ` +
        `price dipping but no real selling pressure. ` +
        `Classic bull trend re-entry setup.`,
      action: "WATCH FOR RE-ENTRY — weak pullback",
    });
  }

  if (hasVolumeDivergence) {
    alerts.push({
      type: "DIVERGENCE",
      urgency: "MEDIUM",
      message:
        `⚡ Volume divergence — price making ` +
        `higher highs but volume is shrinking. ` +
        `Smart money not participating in new highs.`,
      action: "TIGHTEN STOP — distribution signal",
    });
  }

  if (vwapCrossVolume && aboveVWAP) {
    alerts.push({
      type: "VWAP_RECLAIM",
      urgency: "HIGH",
      message:
        `✅ VWAP reclaimed on ${currentVolRatio.toFixed(1)}x ` +
        `volume. High-conviction bull signal. ` +
        `Institutions stepped in at VWAP.`,
      action: "STRONG ENTRY — volume confirmed VWAP reclaim",
    });
  }

  if (vwapCrossVolume && !aboveVWAP) {
    alerts.push({
      type: "VWAP_LOST",
      urgency: "HIGH",
      message:
        `🚨 VWAP lost on ${currentVolRatio.toFixed(1)}x ` +
        `volume. Institutional selling at VWAP. ` +
        `Bull thesis broken.`,
      action: "EXIT CALLS — VWAP lost with conviction",
    });
  }

  return {
    currentVolume: lastCandle.volume,
    avgVolume20: Math.round(avg20),
    currentVolRatio: +currentVolRatio.toFixed(2),
    recentVolRatio: +recentVolRatio.toFixed(2),
    volumeTrend,

    priceVolumeSignal,
    priceVolumeInterpretation,
    isSurge,
    isMegaSurge,
    isClimaxVolume,
    isVolumeDryUp,
    hasVolumeDivergence,
    vwapCrossVolume,
    justCrossedVWAPUp,
    justCrossedVWAPDown,

    volumeScore,
    alerts,

    summary: buildVolumeSummary(
      currentVolRatio,
      priceVolumeSignal,
      priceVolumeInterpretation,
      alerts,
      volumeTrend,
      hasVolumeDivergence,
      isClimaxVolume,
      isVolumeDryUp
    ),

    interpretation: buildVolumeInterpretation(
      currentVolRatio,
      volumeTrend,
      priceVolumeSignal,
      priceUp,
      volUp,
      isClimaxVolume,
      isVolumeDryUp,
      hasVolumeDivergence,
      vwapCrossVolume,
      aboveVWAP
    ),
  };
}

function buildVolumeSummary(
  ratio,
  signal,
  interp,
  alerts,
  trend,
  divergence,
  climax,
  dryUp
) {
  const lines = [];
  lines.push(`Volume: ${ratio.toFixed(1)}x avg (${signal})`);
  lines.push(interp);
  if (alerts.length > 0) {
    lines.push("Volume alerts:");
    alerts.forEach((a) => lines.push(`- ${a.message}`));
  }
  return lines.join("\n");
}

function buildVolumeInterpretation(
  ratio,
  trend,
  signal,
  priceUp,
  volUp,
  climax,
  dryUp,
  divergence,
  vwapCross,
  aboveVWAP
) {
  if (climax) {
    return {
      headline: "CLIMAX VOLUME — TAKE PROFITS",
      detail:
        `Massive ${ratio.toFixed(1)}x volume ` +
        `surge at price high. This often signals ` +
        `exhaustion — everyone who wanted to buy ` +
        `has bought. Consider taking profits now.`,
      color: "#ffd700",
      action: "TAKE PROFITS — potential top",
    };
  }

  if (dryUp) {
    return {
      headline: "VOLUME DRY-UP — RE-ENTRY SIGNAL",
      detail:
        `Price pulling back on very light ` +
        `volume (${ratio.toFixed(1)}x avg). No ` +
        `real selling pressure. Bulls still in ` +
        `control. Classic re-entry setup in ` +
        `a bull trend.`,
      color: "#00ff87",
      action: "WATCH FOR ENTRY — weak pullback",
    };
  }

  if (divergence) {
    return {
      headline: "VOLUME DIVERGENCE — WARNING",
      detail:
        `Price making new highs but volume ` +
        `is shrinking each push. Smart money ` +
        `not participating. Distribution likely. ` +
        `Do not chase — tighten your stop.`,
      color: "#ffd700",
      action: "TIGHTEN STOP — smart money leaving",
    };
  }

  if (vwapCross && aboveVWAP) {
    return {
      headline: "VWAP RECLAIMED ON VOLUME",
      detail:
        `Just crossed above VWAP on ` +
        `${ratio.toFixed(1)}x average volume. ` +
        `This is a strong bull signal — ` +
        `institutions stepped in and bought ` +
        `at VWAP. High-conviction entry.`,
      color: "#00ff87",
      action: "STRONG ENTRY SIGNAL",
    };
  }

  if (vwapCross && !aboveVWAP) {
    return {
      headline: "VWAP LOST ON VOLUME — EXIT",
      detail:
        `Just lost VWAP on ` +
        `${ratio.toFixed(1)}x average volume. ` +
        `Institutions selling at VWAP. ` +
        `Bull thesis is broken. ` +
        `Exit calls immediately.`,
      color: "#ff3b5c",
      action: "EXIT NOW — VWAP lost",
    };
  }

  if (ratio >= 2 && priceUp) {
    return {
      headline: `VOLUME SURGE — ${ratio.toFixed(1)}x AVG`,
      detail:
        `Price rising on ${ratio.toFixed(1)}x ` +
        `normal volume. Real institutional buying ` +
        `behind this move. Not a fake-out. ` +
        `This move has conviction.`,
      color: "#00ff87",
      action: "HIGH CONVICTION — stay in trade",
    };
  }

  if (ratio >= 2 && !priceUp) {
    return {
      headline: `VOLUME SURGE DOWN — ${ratio.toFixed(1)}x`,
      detail:
        `Price dropping on ${ratio.toFixed(1)}x ` +
        `volume. Real selling pressure detected. ` +
        `This is not a normal dip — ` +
        `institutions are exiting.`,
      color: "#ff3b5c",
      action: "EXIT CALLS — real selling",
    };
  }

  if (priceUp && !volUp) {
    return {
      headline: "WEAK MOVE — LOW CONVICTION",
      detail:
        `Price rising but volume is only ` +
        `${ratio.toFixed(1)}x average. No institutional ` +
        `backing. This rally could fade. ` +
        `Wait for volume to confirm before ` +
        `adding to position.`,
      color: "#ffd700",
      action: "HOLD BUT DO NOT ADD — needs volume",
    };
  }

  return {
    headline: `VOLUME ${ratio.toFixed(1)}x AVERAGE`,
    detail: `Volume is ${
      ratio >= 1.5 ? "above" : ratio < 0.7 ? "well below" : "near"
    } average. ${
      trend === "RISING"
        ? "Volume trending up — building momentum."
        : trend === "FALLING"
          ? "Volume fading — watch for conviction."
          : "Volume holding steady."
    }`,
    color: ratio >= 1.5 ? "#00e5ff" : "#4a6070",
    action:
      ratio >= 1.5
        ? "Volume supporting the move"
        : "Watch for volume to confirm",
  };
}

module.exports = { analyzeVolume, normalizeCandles };
