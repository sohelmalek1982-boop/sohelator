const { getStore } = require("@netlify/blobs");

const DECISION_SCHEMA_VERSION = 1;

function getMemoryStore() {
  return getStore({
    name: "trading-memory",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

async function listKeysWithPrefix(store, prefix) {
  const keys = [];
  try {
    for await (const page of store.list({ prefix, paginate: true })) {
      for (const b of page.blobs || []) {
        if (b.key) keys.push(b.key);
      }
    }
  } catch (e) {
    console.error("memory list", prefix, e);
  }
  return keys;
}

async function recordTrade(trade) {
  const store = getMemoryStore();
  const id = "trade_" + Date.now();

  let pnlPct = null;
  if (
    trade.exitPremium != null &&
    trade.entryPremium != null &&
    Number(trade.entryPremium) > 0
  ) {
    pnlPct =
      ((Number(trade.exitPremium) - Number(trade.entryPremium)) /
        Number(trade.entryPremium)) *
      100;
  }

  const executionMode =
    trade.executionMode ||
    (trade.paper === true ? "paper" : trade.paper === false ? "live" : null);

  const tradeRecord = {
    id,
    timestamp: Date.now(),
    date: new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
    }),
    ticker: trade.ticker,
    direction: trade.direction,
    strike: trade.strike,
    expiry: trade.expiry,
    entryPremium: trade.entryPremium,
    exitPremium: trade.exitPremium || null,
    pnlPct,
    outcome: trade.outcome || "open",
    signalScore: trade.signalScore,
    stage: trade.stage,
    indicators: trade.indicators,
    holdDays: trade.holdDays || null,
    exitReason: trade.exitReason || null,
    exitType: trade.exitType || null,
  };
  if (executionMode) {
    tradeRecord.executionMode = executionMode;
    tradeRecord.paper = executionMode === "paper";
  }

  await store.setJSON(id, tradeRecord);
  await updateTickerStats(store, trade.ticker, tradeRecord);
  if (trade.stage) await updatePatternStats(store, trade.stage, tradeRecord);
  await updateBehavioralStats(store, tradeRecord);

  return tradeRecord;
}

async function updateTickerStats(store, ticker, trade) {
  const key = "ticker_stats_" + ticker;
  let stats = (await store.get(key, { type: "json" })) || {
    ticker,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    avgHoldDays: 0,
    bestTrade: null,
    worstTrade: null,
    lastTraded: null,
  };

  stats.totalTrades++;
  const pnl = trade.pnlPct;
  if (trade.outcome === "win" && pnl != null) {
    stats.wins++;
    stats.avgWinPct =
      stats.wins > 0
        ? (stats.avgWinPct * (stats.wins - 1) + pnl) / stats.wins
        : pnl;
    if (!stats.bestTrade || pnl > stats.bestTrade.pnlPct)
      stats.bestTrade = { date: trade.date, pnlPct: pnl };
  }
  if (trade.outcome === "loss" && pnl != null) {
    stats.losses++;
    stats.avgLossPct =
      stats.losses > 0
        ? (stats.avgLossPct * (stats.losses - 1) + pnl) / stats.losses
        : pnl;
    if (!stats.worstTrade || pnl < stats.worstTrade.pnlPct)
      stats.worstTrade = { date: trade.date, pnlPct: pnl };
  }
  stats.winRate =
    stats.totalTrades > 0
      ? Math.round((stats.wins / stats.totalTrades) * 100)
      : 0;
  stats.lastTraded = trade.date;

  await store.setJSON(key, stats);
  return stats;
}

async function updatePatternStats(store, stage, trade) {
  const key = "pattern_stats_" + stage;
  let stats = (await store.get(key, { type: "json" })) || {
    stage,
    totalTrades: 0,
    wins: 0,
    winRate: 0,
    avgPnl: 0,
  };

  stats.totalTrades++;
  if (trade.outcome === "win") stats.wins++;
  stats.winRate = Math.round((stats.wins / stats.totalTrades) * 100);
  if (trade.pnlPct != null) {
    stats.avgPnl =
      (stats.avgPnl * (stats.totalTrades - 1) + trade.pnlPct) /
      stats.totalTrades;
  }

  await store.setJSON(key, stats);
  return stats;
}

async function updateBehavioralStats(store, trade) {
  const key = "behavioral_stats";
  let stats = (await store.get(key, { type: "json" })) || {
    totalTrades: 0,
    avgHoldDays: 0,
    exitTooEarlyCount: 0,
    heldLoserCount: 0,
    perfectExitCount: 0,
    bestTimeOfDay: {},
    worstTimeOfDay: {},
    winsByDayOfWeek: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 },
    tradesByDayOfWeek: { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 },
  };

  stats.totalTrades++;

  if (trade.exitType === "target") stats.perfectExitCount++;
  if (
    trade.exitType === "manual" &&
    trade.outcome === "win" &&
    trade.pnlPct != null &&
    trade.pnlPct < 40
  )
    stats.exitTooEarlyCount++;
  if (
    trade.exitType === "manual" &&
    trade.outcome === "loss" &&
    trade.pnlPct != null &&
    trade.pnlPct < -50
  )
    stats.heldLoserCount++;

  const day = new Date(trade.timestamp).toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "America/New_York",
  });
  if (stats.tradesByDayOfWeek[day] !== undefined) {
    stats.tradesByDayOfWeek[day]++;
    if (trade.outcome === "win") stats.winsByDayOfWeek[day]++;
  }

  await store.setJSON(key, stats);
  return stats;
}

function buildInsights(tickerStats, patternStats, behavioral, recentTrades) {
  const insights = [];

  const bestTicker = tickerStats
    .filter((t) => t && t.totalTrades >= 3)
    .sort((a, b) => b.winRate - a.winRate)[0];
  if (bestTicker)
    insights.push(
      `Best ticker: ${bestTicker.ticker} (${bestTicker.winRate}% win rate, ${bestTicker.totalTrades} trades)`
    );

  const worstTicker = tickerStats
    .filter((t) => t && t.totalTrades >= 3)
    .sort((a, b) => a.winRate - b.winRate)[0];
  if (worstTicker && worstTicker.winRate < 40)
    insights.push(
      `Avoid: ${worstTicker.ticker} (only ${worstTicker.winRate}% win rate)`
    );

  const bestPattern = patternStats
    .filter((p) => p && p.totalTrades >= 3)
    .sort((a, b) => b.winRate - a.winRate)[0];
  if (bestPattern)
    insights.push(
      `Best setup: ${bestPattern.stage} (${bestPattern.winRate}% personal win rate)`
    );

  if (behavioral) {
    if (behavioral.exitTooEarlyCount > 2)
      insights.push(
        `Pattern: You exit winners too early (${behavioral.exitTooEarlyCount} times). Trust the trail stop system.`
      );
    if (behavioral.heldLoserCount > 2)
      insights.push(
        `Pattern: You hold losers too long (${behavioral.heldLoserCount} times). Cut at -40% no exceptions.`
      );
  }

  if (behavioral?.tradesByDayOfWeek && behavioral?.winsByDayOfWeek) {
    const days = Object.keys(behavioral.winsByDayOfWeek);
    const dayWinRates = days
      .map((d) => {
        const trades = behavioral.tradesByDayOfWeek[d] || 0;
        const wins = behavioral.winsByDayOfWeek[d] || 0;
        return {
          day: d,
          winRate: trades > 0 ? Math.round((wins / trades) * 100) : 0,
          trades,
        };
      })
      .filter((d) => d.trades >= 2);
    const bestDay = dayWinRates.sort((a, b) => b.winRate - a.winRate)[0];
    if (bestDay)
      insights.push(
        `Best trading day: ${bestDay.day} (${bestDay.winRate}% win rate)`
      );
  }

  return insights;
}

const NY_TZ = "America/New_York";

function getSessionMinute() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TZ,
    weekday: "long",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(now);
  const wd = parts.find((p) => p.type === "weekday")?.value;
  if (wd === "Saturday" || wd === "Sunday") return 0;
  const h = +parts.find((p) => p.type === "hour").value;
  const m = +parts.find((p) => p.type === "minute").value;
  const minutesFromMidnight = h * 60 + m;
  const openMin = 9 * 60 + 30;
  const closeMin = 16 * 60;
  if (minutesFromMidnight < openMin) return 0;
  if (minutesFromMidnight > closeMin) return Math.max(0, closeMin - openMin);
  return minutesFromMidnight - openMin;
}

function nyDateParts() {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", { timeZone: NY_TZ });
  const timeOfDay = now.toLocaleTimeString("en-US", {
    timeZone: NY_TZ,
    hour12: true,
  });
  const dayOfWeek = now.toLocaleDateString("en-US", {
    timeZone: NY_TZ,
    weekday: "long",
  });
  return { date, timeOfDay, dayOfWeek };
}

function buildAlertSnapshotPayload(alert, master) {
  const tf = master?.timeframes;
  const fiveM = tf?.fiveMin;
  const mom = master?.momentum;
  const vol = master?.volume;
  const lv = master?.levels;
  const ign = master?.ignition || alert?.ignition;
  const ignEngines = ign?.engines || {};
  const flow = master?.optionsFlow;
  const gex = master?.gex;
  const mp = master?.marketProfile;
  const sec = master?.sector;
  const li = master?.levelInteraction;
  const pz = master?.pivotZones;

  const priceAtAlert =
    alert?.underlyingAtAlert ??
    alert?.indicators?.price ??
    alert?.price ??
    null;

  const stageStr = String(alert?.stage || "");
  const isBear =
    stageStr.includes("bear") ||
    /PUT|BEAR|fade/i.test(String(alert?.setupType || "")) ||
    String(alert?.option?.optType || "").toLowerCase() === "put";

  const nearestResistance = lv?.nearestResistance;
  const nearestSupport = lv?.nearestSupport;

  return {
    id: alert.id,
    ticker: alert.ticker,
    timestamp: Date.now(),
    decisionSchemaVersion: DECISION_SCHEMA_VERSION,
    ...nyDateParts(),
    sessionMinute: getSessionMinute(),

    prediction: {
      direction: isBear ? "BEAR" : "BULL",
      stage: alert.stage,
      stageLabel: alert.stageLabel,
      action: alert.action,
      optionStrike: alert.option?.strike,
      optionExpiry: alert.option?.expiry,
      optionPremium: alert.premiumAtAlert,
      targetLevel:
        nearestResistance?.price ??
        nearestSupport?.price ??
        null,
      stopLevel: alert.option?.strike,
      winRateAtTime: alert.winRate != null ? alert.winRate : null,
      urgencyTier: alert.urgencyTier ?? null,
      ignitionScore:
        ign?.ignitionScore ??
        ign?.score ??
        master?.ignition?.ignitionScore ??
        null,
    },

    indicators: {
      priceAtAlert,
      adx: fiveM?.adx ?? alert.indicators?.adx,
      adxSlope: alert.indicators?.adxSlope,
      adxStrength: fiveM?.strength,
      macd: alert.indicators?.macd,
      macdSlope: alert.indicators?.macdSlope,
      macdExpandingBars: ignEngines?.momentum?.expandingBars,
      rsi: alert.indicators?.rsi,
      rsiVelocity: ignEngines?.momentum?.rsiVelocity,
      stochRsiK: mom?.stochRSI?.k,
      stochRsiD: mom?.stochRSI?.d,
      cci: mom?.cci,
      williamsR: mom?.williamsR,
      vwapDist: alert.indicators?.vwapDist,
      aboveVWAP: (parseFloat(alert.indicators?.vwapDist) || 0) > 0,
      bbPctB: master?.bbPctB ?? alert.indicators?.bbB,
      priceAccelRatio: ignEngines?.price?.ratio,
      atr: mom?.atr,
      atrPct:
        mom?.atrPct != null
          ? parseFloat(String(mom.atrPct).replace(/%/g, "")) || null
          : null,
      volumeRatio: alert.volume?.ratio,
      volumeSignal: alert.volume?.signal,
      volumeExpanding: vol?.expanding,
      volumeExpandingBars: vol?.expandingStreak,
      tfAlignScore: tf?.alignmentScore,
      dailyTrend: tf?.daily?.trend,
      fourHTrend: tf?.fourHour?.trend,
      oneHTrend: tf?.oneHour?.trend,
      bullCount: tf?.bullCount,
      bearCount: tf?.bearCount,
    },

    ignition: {
      score: ign?.ignitionScore ?? ign?.score ?? null,
      status: ign?.status,
      direction: ign?.direction,
      priceEngineScore: ignEngines?.price?.score,
      momentumEngineScore: ignEngines?.momentum?.score,
      volumeEngineScore: ignEngines?.volume?.score,
      allEnginesFiring: !!(
        ignEngines?.price?.score >= 75 &&
        ignEngines?.momentum?.score >= 75 &&
        ignEngines?.volume?.score >= 75
      ),
    },

    levels: {
      interactionType: li?.interactionType,
      interactionLevel: li?.level?.label,
      interactionPrice: li?.level?.price,
      interactionConfidence: li?.confidence,
      nearestResistance: nearestResistance?.price,
      nearestResistanceLabel: nearestResistance?.label,
      nearestSupport: nearestSupport?.price,
      nearestSupportLabel: nearestSupport?.label,
      distToResistance: lv?.rewardToResistance,
      distToSupport: lv?.riskToSupport,
      riskRewardRatio: lv?.riskRewardRatio,
      pivotPP: pz?.pp,
      pivotR1: pz?.r1,
      pivotS1: pz?.s1,
    },

    market: {
      regime: master?.regime?.primary,
      vixLevel: master?.marketContext?.vix ?? null,
      spyChangePct: master?.marketContext?.spyChange ?? null,
      sectorMomentum: sec?.sectorMomentum,
      sectorPerformance: sec?.sectorPerformance,
      marketBreadth: sec?.marketBreadth,
      gexRegime: gex?.gexRegime,
      gexFlipNearby: gex?.tradingImplication?.flipWarning != null,
      flowBias: flow?.smartMoneyBias,
      unusualActivity: Array.isArray(flow?.unusualActivity)
        ? flow.unusualActivity.length > 0
        : false,
      putCallRatio: flow?.volumePCR,
      marketProfilePosition: mp?.pricePosition,
      aboveVAH: mp?.pricePosition === "ABOVE_VALUE_AREA",
      pocPrice: mp?.poc,
    },

    outcome: {
      filled: false,
      priceAtClose: null,
      premiumAtClose: null,
      stockMovePct: null,
      estimatedOptionReturn: null,
      hitTarget: null,
      hitStop: null,
      maxGain: null,
      maxLoss: null,
      holdMinutes: null,
      exitReason: null,
      correct: null,
    },
  };
}

async function recordAlertSnapshot(alert, master) {
  const store = getMemoryStore();
  if (!alert?.id) {
    console.warn("recordAlertSnapshot: missing alert.id");
    return null;
  }
  const snapshot = buildAlertSnapshotPayload(alert, master);
  snapshot.id = alert.id;

  await store.setJSON(`snapshot_${alert.id}`, snapshot);

  const todayKey = `snapshots_${snapshot.date.replace(/\//g, "_")}`;
  let todayList = (await store.get(todayKey, { type: "json" })) || [];
  if (!Array.isArray(todayList)) todayList = [];
  if (!todayList.includes(alert.id)) {
    todayList.push(alert.id);
    await store.setJSON(todayKey, todayList);
  }

  return snapshot;
}

async function getMemoryContext(ticker = null) {
  const store = getMemoryStore();

  const tradeKeyList = await listKeysWithPrefix(store, "trade_");
  const recentKeys = tradeKeyList.sort((a, b) => b.localeCompare(a)).slice(0, 30);
  const recentTrades = (
    await Promise.all(recentKeys.map((k) => store.get(k, { type: "json" })))
  ).filter(Boolean);

  let tickerStats = null;
  if (ticker) {
    tickerStats = await store.get("ticker_stats_" + ticker, {
      type: "json",
    });
  }

  const tickerStatKeys = await listKeysWithPrefix(store, "ticker_stats_");
  const allTickerStats = (
    await Promise.all(
      tickerStatKeys.map((k) => store.get(k, { type: "json" }))
    )
  ).filter(Boolean);

  const patternKeys = await listKeysWithPrefix(store, "pattern_stats_");
  const allPatternStats = (
    await Promise.all(patternKeys.map((k) => store.get(k, { type: "json" })))
  ).filter(Boolean);

  const behavioralStats = await store.get("behavioral_stats", {
    type: "json",
  });

  const insights = buildInsights(
    allTickerStats,
    allPatternStats,
    behavioralStats,
    recentTrades
  );

  return {
    recentTrades: recentTrades.slice(0, 10),
    tickerStats,
    allTickerStats,
    allPatternStats,
    behavioralStats,
    insights,
  };
}

module.exports = {
  recordTrade,
  getMemoryContext,
  updateTickerStats,
  buildInsights,
  getMemoryStore,
  getSessionMinute,
  buildAlertSnapshotPayload,
  recordAlertSnapshot,
};
