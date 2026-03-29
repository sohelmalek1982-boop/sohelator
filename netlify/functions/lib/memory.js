const { getStore } = require("@netlify/blobs");

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
};
