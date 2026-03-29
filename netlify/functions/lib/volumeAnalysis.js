/**
 * Intraday 5m volume analysis — session candles only (US equities, NY calendar day).
 * Ratios compare the current bar vs a recent intraday baseline (last 5 completed bars),
 * not multi-day / overnight aggregates.
 */

function candleTimeMs(c) {
  const t = c?.time ?? c?.t ?? c?.timestamp;
  if (t == null) return null;
  const n = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t));
  return Number.isFinite(n) ? n : null;
}

function nyDateKey(ms) {
  if (ms == null) return null;
  return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function normalizeCandle(c) {
  if (!c) return null;
  const high = +(c.high ?? c.h);
  const low = +(c.low ?? c.l);
  const close = +(c.close ?? c.c);
  const volume = Math.max(1, +(c.volume ?? c.vol ?? c.v ?? 0));
  if (Number.isNaN(close)) return null;
  const time = candleTimeMs(c);
  return { high, low, close, volume, time };
}

function normalizeCandles(candles) {
  if (!candles || !candles.length) return [];
  return candles.map(normalizeCandle).filter(Boolean);
}

/** Keep only candles on the same NY session day as the last bar (current session). */
function filterSessionCandles(norm) {
  if (!norm.length) return [];
  const lastMs = candleTimeMs(norm[norm.length - 1]);
  const dayKey = lastMs != null ? nyDateKey(lastMs) : null;
  if (!dayKey) return norm;
  return norm.filter((c) => {
    const ms = candleTimeMs(c);
    return ms != null && nyDateKey(ms) === dayKey;
  });
}

/**
 * @param {object[]} candles - raw OHLCV (5m), may include `time` / `t`
 * @param {object} _quote - reserved
 */
function analyzeVolume(candles, _quote) {
  const normAll = normalizeCandles(candles);
  if (!normAll.length) return null;

  const norm = filterSessionCandles(normAll);
  if (norm.length < 3) return null;

  const volumes = norm.map((c) => c.volume);
  const closes = norm.map((c) => c.close);
  const highs = norm.map((c) => c.high);

  const sessionAvg =
    volumes.reduce((a, b) => a + b, 0) / volumes.length;

  /** Last 5 completed bars (exclude forming current bar) — intraday baseline. */
  let recentCandles = volumes.length >= 6 ? volumes.slice(-6, -1) : volumes.slice(0, -1);
  if (recentCandles.length === 0) recentCandles = [volumes[volumes.length - 1]];
  const recentAvg =
    recentCandles.reduce((a, b) => a + b, 0) / recentCandles.length;

  const lastCandle = norm[norm.length - 1];
  const currentVol = lastCandle.volume;
  const prevVol = volumes.length >= 2 ? volumes[volumes.length - 2] : currentVol;
  const prev2Vol = volumes.length >= 3 ? volumes[volumes.length - 3] : prevVol;

  const baseline = recentAvg > 0 ? recentAvg : sessionAvg > 0 ? sessionAvg : 1;
  const currentVolRatio = baseline > 0 ? currentVol / baseline : 1;

  const last3Avg =
    volumes.length >= 3
      ? volumes.slice(-3).reduce((a, b) => a + b, 0) / 3
      : currentVol;
  const recentVolRatio = sessionAvg > 0 ? last3Avg / sessionAvg : 1;

  const vol5 = volumes.slice(-5);
  const volSlope =
    vol5.length >= 3 && vol5[0] > 0
      ? (vol5[vol5.length - 1] - vol5[0]) / vol5[0]
      : 0;
  const volumeTrend =
    volSlope > 0.1 ? "RISING" : volSlope < -0.1 ? "FALLING" : "FLAT";

  const volExpanding =
    currentVol > prevVol && prevVol > prev2Vol;

  let expandingStreak = 0;
  for (let i = volumes.length - 1; i > 0; i--) {
    if (volumes[i] > volumes[i - 1]) expandingStreak++;
    else break;
  }

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
      `recent intraday volume. Real participation on this 5m bar.`;
  } else if (priceUp && !volUp) {
    priceVolumeSignal = "WEAK MOVE";
    priceVolumeInterpretation =
      `Price rising but volume is light vs recent 5m bars. ` +
      `No strong intraday conviction — move may fade.`;
  } else if (!priceUp && volUp) {
    priceVolumeSignal = "BEARISH CONFIRMATION";
    priceVolumeInterpretation =
      `Price dropping on ${currentVolRatio.toFixed(1)}x ` +
      `recent intraday volume. Selling pressure showing in the tape.`;
  } else {
    priceVolumeSignal = "WEAK SELLING";
    priceVolumeInterpretation =
      `Price dipping on lighter-than-recent volume. ` +
      `Often a normal pullback if trend is intact.`;
  }

  const isSurge = currentVolRatio >= 2.0;
  const isMegaSurge = currentVolRatio >= 4.0;

  const recentHighs = highs.slice(-10);
  const maxHigh = recentHighs.length ? Math.max(...recentHighs) : 0;
  const allTimeHighInWindow =
    maxHigh > 0 && closes[closes.length - 1] >= maxHigh * 0.995;
  const isClimaxVolume =
    isMegaSurge &&
    allTimeHighInWindow &&
    (expandingStreak >= 2 || volExpanding);

  const midSlice =
    closes.length >= 10
      ? closes.slice(-10, -3)
      : closes.slice(0, Math.max(0, closes.length - 3));
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

  /** Session VWAP — only today's 5m bars. */
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
  if (volExpanding && priceUp) volumeScore += 5;
  volumeScore = Math.max(0, Math.min(100, volumeScore));

  const alerts = [];

  if (isMegaSurge && priceUp) {
    alerts.push({
      type: "SURGE_BULL",
      urgency: "HIGH",
      message:
        `🔥 Intraday volume SURGE — ` +
        `${currentVolRatio.toFixed(1)}x recent 5m avg. ` +
        `Institutions active — strong confirmation.`,
      action: "ENTER OR ADD — high conviction move",
    });
  }

  if (isMegaSurge && !priceUp) {
    alerts.push({
      type: "SURGE_BEAR",
      urgency: "HIGH",
      message:
        `🚨 SURGE on DOWN 5m bar — ` +
        `${currentVolRatio.toFixed(1)}x recent avg. ` +
        `Real selling pressure.`,
      action: "EXIT CALLS — heavy selling volume",
    });
  }

  if (isClimaxVolume) {
    alerts.push({
      type: "CLIMAX",
      urgency: "HIGH",
      message:
        `⚠️ CLIMAX intraday volume near session high — ` +
        `possible exhaustion after volume ramp.`,
      action: "TAKE PROFITS — watch next candle",
    });
  }

  if (isVolumeDryUp) {
    alerts.push({
      type: "DRY_UP",
      urgency: "MEDIUM",
      message:
        `👀 Volume dry-up on pullback — ` +
        `light vs recent 5m bars. Weak selling into dip.`,
      action: "WATCH FOR RE-ENTRY — weak pullback",
    });
  }

  if (hasVolumeDivergence) {
    alerts.push({
      type: "DIVERGENCE",
      urgency: "MEDIUM",
      message:
        `⚡ Intraday divergence — higher highs, ` +
        `volume not confirming on 5m.`,
      action: "TIGHTEN STOP — distribution signal",
    });
  }

  if (vwapCrossVolume && aboveVWAP) {
    alerts.push({
      type: "VWAP_RECLAIM",
      urgency: "HIGH",
      message:
        `✅ VWAP reclaimed on ${currentVolRatio.toFixed(1)}x ` +
        `recent volume. Session buyers defending.`,
      action: "STRONG ENTRY — VWAP reclaim confirmed",
    });
  }

  if (vwapCrossVolume && !aboveVWAP) {
    alerts.push({
      type: "VWAP_LOST",
      urgency: "HIGH",
      message:
        `🚨 VWAP lost on ${currentVolRatio.toFixed(1)}x ` +
        `intraday volume.`,
      action: "EXIT CALLS — VWAP lost with size",
    });
  }

  return {
    currentVolume: lastCandle.volume,
    /** @deprecated use avgVolumeRecent — kept for older clients */
    avgVolume20: Math.round(recentAvg),
    avgVolumeRecent: Math.round(recentAvg),
    avgVolumeSession: Math.round(sessionAvg),
    baseline: "intraday_5m_session",
    currentVolRatio: +currentVolRatio.toFixed(2),
    recentVolRatio: +recentVolRatio.toFixed(2),
    volumeTrend,
    volExpanding,
    expandingStreak,

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
  lines.push(`Intraday 5m volume: ${ratio.toFixed(1)}x recent bar avg (${signal})`);
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
        `Massive ${ratio.toFixed(1)}x recent 5m volume ` +
        `into the session high. Often marks a short-term exhaustion.`,
      color: "#ffd700",
      action: "TAKE PROFITS — potential top",
    };
  }

  if (dryUp) {
    return {
      headline: "VOLUME DRY-UP — RE-ENTRY SIGNAL",
      detail:
        `Pullback on very light volume (${ratio.toFixed(1)}x ` +
        `recent bars). Little institutional selling into the dip.`,
      color: "#00ff87",
      action: "WATCH FOR ENTRY — weak pullback",
    };
  }

  if (divergence) {
    return {
      headline: "VOLUME DIVERGENCE — WARNING",
      detail:
        `Price pressing higher but 5m volume is fading. ` +
        `Participation not confirming the move.`,
      color: "#ffd700",
      action: "TIGHTEN STOP — smart money leaving",
    };
  }

  if (vwapCross && aboveVWAP) {
    return {
      headline: "VWAP RECLAIMED ON VOLUME",
      detail:
        `Cross back above session VWAP on ${ratio.toFixed(1)}x ` +
        `recent intraday volume.`,
      color: "#00ff87",
      action: "STRONG ENTRY SIGNAL",
    };
  }

  if (vwapCross && !aboveVWAP) {
    return {
      headline: "VWAP LOST ON VOLUME — EXIT",
      detail:
        `Lost session VWAP on elevated 5m volume vs recent bars.`,
      color: "#ff3b5c",
      action: "EXIT NOW — VWAP lost",
    };
  }

  if (ratio >= 2 && priceUp) {
    return {
      headline: `VOLUME SURGE — ${ratio.toFixed(1)}x RECENT AVG`,
      detail:
        `This 5m bar is printing well above the prior five completed bars — ` +
        `real participation behind the push.`,
      color: "#00ff87",
      action: "HIGH CONVICTION — stay in trade",
    };
  }

  if (ratio >= 2 && !priceUp) {
    return {
      headline: `VOLUME SURGE DOWN — ${ratio.toFixed(1)}x`,
      detail:
        `Down candle with heavy volume vs recent 5m baseline — ` +
        `not a quiet drift lower.`,
      color: "#ff3b5c",
      action: "EXIT CALLS — real selling",
    };
  }

  if (priceUp && !volUp) {
    return {
      headline: "WEAK MOVE — LOW CONVICTION",
      detail:
        `Up bar but only ${ratio.toFixed(1)}x recent average volume — ` +
        `wait for volume to confirm before adding.`,
      color: "#ffd700",
      action: "HOLD BUT DO NOT ADD — needs volume",
    };
  }

  return {
    headline: `VOLUME ${ratio.toFixed(1)}x RECENT AVG`,
    detail: `Vs prior five completed 5m bars, volume is ${
      ratio >= 1.5 ? "above" : ratio < 0.7 ? "well below" : "near"
    } average. ${
      trend === "RISING"
        ? "Volume building bar to bar."
        : trend === "FALLING"
          ? "Volume fading — watch the next candle."
          : "Volume steady."
    }`,
    color: ratio >= 1.5 ? "#00e5ff" : "#4a6070",
    action:
      ratio >= 1.5
        ? "Volume supporting the move"
        : "Watch for volume to confirm",
  };
}

module.exports = { analyzeVolume, normalizeCandles };
