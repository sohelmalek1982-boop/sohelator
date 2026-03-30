// ── Intraday helpers ──────────────────────────────────────────────────────────

/** Filter 5-min candles to the current NY session day (same approach as volumeAnalysis). */
function _sessionCandlesIntraday(candles) {
  if (!candles || !candles.length) return [];
  function msOf(c) {
    const t = c.time || c.t || c.timestamp;
    if (t == null) return null;
    const n = typeof t === "number" ? (t < 1e12 ? t * 1000 : t) : Date.parse(String(t));
    return Number.isFinite(n) ? n : null;
  }
  function nyDay(ms) {
    return new Date(ms).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  const lastMs = msOf(candles[candles.length - 1]);
  if (!lastMs) return candles;
  const today = nyDay(lastMs);
  return candles.filter((c) => { const ms = msOf(c); return ms != null && nyDay(ms) === today; });
}

/** Build hourly candles from 5-min by grouping 12 consecutive bars. */
function _buildHourly(fiveMinCandles) {
  const out = [];
  for (let i = 0; i < fiveMinCandles.length; i += 12) {
    const g = fiveMinCandles.slice(i, i + 12);
    if (!g.length) continue;
    out.push({
      time: g[0].time,
      open: g[0].open,
      high: Math.max(...g.map((c) => c.high)),
      low: Math.min(...g.map((c) => c.low)),
      close: g[g.length - 1].close,
      volume: g.reduce((s, c) => s + (c.volume || c.vol || 0), 0),
    });
  }
  return out;
}

/** 3-candle pivot swing detection. Returns [{price, type: 'high'|'low', idx}] newest-first. */
function _detectSwings(candles) {
  const swings = [];
  for (let i = candles.length - 2; i >= 1; i--) {
    const prev = candles[i - 1], cur = candles[i], next = candles[i + 1];
    if (cur.high > prev.high && cur.high > next.high) {
      swings.push({ price: cur.high, type: "high", idx: i });
    } else if (cur.low < prev.low && cur.low < next.low) {
      swings.push({ price: cur.low, type: "low", idx: i });
    }
    if (swings.length >= 6) break;
  }
  return swings;
}

/**
 * Calculate intraday key levels from 5-min candle data.
 * Returns array of level objects compatible with calculateKeyLevels() output.
 */
function calculateIntradayLevels(fiveMinCandles, currentPrice) {
  const session = _sessionCandlesIntraday(fiveMinCandles);
  if (session.length < 3) return [];
  const price = +currentPrice || 0;
  const levels = [];

  // ── Opening Range (first 30 min = first 6 × 5-min bars, 9:30–10:00 ET) ──
  const orBars = session.slice(0, Math.min(6, session.length));
  if (orBars.length >= 2) {
    const orH = Math.max(...orBars.map((c) => c.high));
    const orL = Math.min(...orBars.map((c) => c.low));
    levels.push({ price: orH, type: price >= orH ? "support" : "resistance", label: "Opening Range High", strength: "major", timeframe: "intraday" });
    levels.push({ price: orL, type: price <= orL ? "resistance" : "support",  label: "Opening Range Low",  strength: "major", timeframe: "intraday" });
  }

  // ── Previous Hour High / Low ──────────────────────────────────────────────
  const hourly = _buildHourly(session);
  if (hourly.length >= 2) {
    const ph = hourly[hourly.length - 2];
    levels.push({ price: ph.high, type: price >= ph.high ? "support" : "resistance", label: "Prev Hour High", strength: "moderate", timeframe: "intraday" });
    levels.push({ price: ph.low,  type: price <= ph.low  ? "resistance" : "support",  label: "Prev Hour Low",  strength: "moderate", timeframe: "intraday" });
  }

  // ── Current Hour High / Low (intrabar reference) ──────────────────────────
  if (hourly.length >= 1) {
    const ch = hourly[hourly.length - 1];
    levels.push({ price: ch.high, type: "resistance", label: "Current Hour High", strength: "minor", timeframe: "intraday" });
    levels.push({ price: ch.low,  type: "support",    label: "Current Hour Low",  strength: "minor", timeframe: "intraday" });
  }

  // ── Intraday Swing Highs / Lows (5-min pivots) ───────────────────────────
  const swings = _detectSwings(session);
  const seen = new Set();
  swings.slice(0, 4).forEach((s) => {
    const key = s.price.toFixed(2);
    if (seen.has(key)) return;
    seen.add(key);
    levels.push({
      price: s.price,
      type: s.type === "high" ? (price >= s.price ? "support" : "resistance") : (price <= s.price ? "resistance" : "support"),
      label: s.type === "high" ? "Intraday Swing High" : "Intraday Swing Low",
      strength: "minor",
      timeframe: "intraday",
    });
  });

  // ── Session High / Low (whole day so far) ────────────────────────────────
  const sessionH = Math.max(...session.map((c) => c.high));
  const sessionL = Math.min(...session.map((c) => c.low));
  levels.push({ price: sessionH, type: "resistance", label: "Session High", strength: "moderate", timeframe: "intraday" });
  levels.push({ price: sessionL, type: "support",    label: "Session Low",  strength: "moderate", timeframe: "intraday" });

  return levels.map((l) => ({
    ...l,
    distancePct: (((l.price - price) / price) * 100).toFixed(2),
    distanceAbs: Math.abs(l.price - price),
  }));
}

/**
 * Detect level interactions on recent candles against a combined set of levels.
 *
 * @param {object[]} recentCandles - last 3-5 candles (OHLCV, most recent last)
 * @param {object[]} allLevels     - combined daily + intraday levels array
 * @param {number}   volRatio      - currentVolRatio from analyzeVolume (1.0 = avg)
 * @returns {object|null}
 */
function detectLevelInteraction(recentCandles, allLevels, volRatio) {
  if (!recentCandles || recentCandles.length < 2 || !allLevels || !allLevels.length) return null;

  const cur  = recentCandles[recentCandles.length - 1];
  const prev = recentCandles[recentCandles.length - 2];
  const price = cur.close;
  const volOk = (volRatio || 1) >= 1.25;

  const results = [];

  for (const lvl of allLevels) {
    const lp = lvl.price;
    if (!lp || lp <= 0) continue;

    // Tolerances: 0.15 % for clean break, 0.05 % for wick touch
    const closeAbove = price   > lp * 1.0015;
    const closeBelow = price   < lp * 0.9985;
    const prevAbove  = prev.close > lp * 1.001;
    const prevBelow  = prev.close < lp * 0.999;
    const highOver   = cur.high   > lp * 1.0005;
    const lowUnder   = cur.low    < lp * 0.9995;
    const distPct    = ((price - lp) / lp) * 100;
    const absDist    = Math.abs(distPct);

    let type = null;

    if (closeAbove && prevBelow) {
      // Closed above a level it was previously below → breakout / reclaim
      type = volOk ? "BREAKOUT" : "WEAK_BREAKOUT";
    } else if (closeBelow && prevAbove) {
      // Closed below a level it was previously above → breakdown / lose
      type = volOk ? "BREAKDOWN" : "WEAK_BREAKDOWN";
    } else if (highOver && closeBelow && !prevAbove) {
      // Wick above resistance, close back below → rejection
      type = "REJECTION";
    } else if (lowUnder && closeAbove && !prevBelow) {
      // Wick below support, close back above → bounce
      type = "BOUNCE";
    } else if (absDist < 0.25) {
      // Very close to a level, no clean cross yet
      type = "TESTING";
    } else if (absDist < 0.5) {
      type = "APPROACHING";
    }

    if (!type) continue;

    results.push({
      type,
      levelPrice: lp,
      levelLabel: lvl.label,
      levelStrength: lvl.strength || "minor",
      levelType: lvl.type,
      levelTimeframe: lvl.timeframe || "daily",
      distancePct: distPct.toFixed(3),
      volConfirmed: volOk,
    });
  }

  if (!results.length) return null;

  // Priority order: actionable events first
  const ORDER = ["BREAKOUT", "BREAKDOWN", "REJECTION", "BOUNCE", "WEAK_BREAKOUT", "WEAK_BREAKDOWN", "TESTING", "APPROACHING"];
  // Within same type, prefer: major > moderate > minor; daily > intraday
  const strengthRank = { major: 0, moderate: 1, minor: 2 };
  results.sort((a, b) => {
    const oa = ORDER.indexOf(a.type); const ob = ORDER.indexOf(b.type);
    if (oa !== ob) return oa - ob;
    const sa = strengthRank[a.levelStrength] ?? 3;
    const sb = strengthRank[b.levelStrength] ?? 3;
    return sa - sb;
  });

  const top = results[0];

  let signal, action, scoreImpact, direction;
  const isMajor = top.levelStrength === "major";

  switch (top.type) {
    case "BREAKOUT":
      signal    = `🚀 BREAKOUT above ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — volume confirmed`;
      action    = "CALL ENTRY — resistance broken with conviction";
      scoreImpact = isMajor ? 25 : 15;
      direction   = "BULL";
      break;
    case "WEAK_BREAKOUT":
      signal    = `📈 Weak breakout above ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — needs volume`;
      action    = "WATCH — breakout not confirmed by volume yet";
      scoreImpact = 8;
      direction   = "BULL";
      break;
    case "BREAKDOWN":
      signal    = `🔴 BREAKDOWN below ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — volume confirmed`;
      action    = "PUT ENTRY — support lost with conviction";
      scoreImpact = isMajor ? 25 : 15;
      direction   = "BEAR";
      break;
    case "WEAK_BREAKDOWN":
      signal    = `📉 Weak breakdown below ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — needs volume`;
      action    = "WATCH — breakdown not confirmed by volume yet";
      scoreImpact = 6;
      direction   = "BEAR";
      break;
    case "REJECTION":
      signal    = `⚠️ REJECTION at ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — wicked above, closed back below`;
      action    = "PUT SETUP — failed breakout, smart money selling the rip";
      scoreImpact = isMajor ? 20 : 10;
      direction   = "BEAR";
      break;
    case "BOUNCE":
      signal    = `✅ BOUNCE off ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — support held, wick reclaimed`;
      action    = "CALL SETUP — support bounce, buyers stepped in";
      scoreImpact = isMajor ? 20 : 10;
      direction   = "BULL";
      break;
    case "TESTING":
      signal    = `👀 TESTING ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — at the level, reaction imminent`;
      action    = "GET READY — watch next candle for breakout or rejection";
      scoreImpact = 5;
      direction   = "WATCH";
      break;
    case "APPROACHING":
      signal    = `📊 Approaching ${top.levelLabel} ($${(+top.levelPrice).toFixed(2)}) — ${Math.abs(+top.distancePct).toFixed(2)}% away`;
      action    = "PREPARE — level reaction incoming, have order ready";
      scoreImpact = 0;
      direction   = "WATCH";
      break;
    default:
      signal = ""; action = ""; scoreImpact = 0; direction = "NEUTRAL";
  }

  const isActionable = ["BREAKOUT", "BREAKDOWN", "REJECTION", "BOUNCE"].includes(top.type);
  const isHighConviction = isActionable && isMajor && top.volConfirmed;

  return {
    ...top,
    signal,
    action,
    scoreImpact,
    direction,
    isActionable,
    isHighConviction,
    allInteractions: results.slice(0, 4),
  };
}

// ─────────────────────────────────────────────────────────────────────────────

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

module.exports = { calculateKeyLevels, buildLevelsSummary, calculateIntradayLevels, detectLevelInteraction };
