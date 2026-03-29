function analyzeGroup(snapshots, filter) {
  const group = snapshots.filter(filter).filter((s) => s.outcome?.filled);
  if (group.length === 0) return null;

  const resolved = group.filter(
    (s) => s.outcome?.correct !== null && s.outcome?.correct !== undefined
  );
  const wins = resolved.filter((s) => s.outcome.correct === true).length;
  const total = resolved.length;

  const retVals = group
    .map((s) => s.outcome?.estimatedOptionReturn)
    .filter((v) => v != null && !Number.isNaN(Number(v)));
  const avgReturn =
    retVals.length > 0
      ? retVals.reduce((a, b) => a + Number(b), 0) / retVals.length
      : null;

  return {
    count: group.length,
    winRate: total > 0 ? Math.round((wins / total) * 100) : null,
    avgReturn: avgReturn != null ? +avgReturn.toFixed(1) : null,
    wins,
    losses: total - wins,
    total,
  };
}

function analyzePatterns(snapshots) {
  return {
    ignitionRanges: {
      "80-100": analyzeGroup(snapshots, (s) => (s.ignition?.score ?? 0) >= 80),
      "65-79": analyzeGroup(
        snapshots,
        (s) =>
          (s.ignition?.score ?? 0) >= 65 && (s.ignition?.score ?? 0) < 80
      ),
      "50-64": analyzeGroup(
        snapshots,
        (s) =>
          (s.ignition?.score ?? 0) >= 50 && (s.ignition?.score ?? 0) < 65
      ),
      below50: analyzeGroup(snapshots, (s) => (s.ignition?.score ?? 0) < 50),
    },
    levelTypes: {
      BREAKOUT: analyzeGroup(
        snapshots,
        (s) => s.levels?.interactionType === "BREAKOUT"
      ),
      BREAKDOWN: analyzeGroup(
        snapshots,
        (s) => s.levels?.interactionType === "BREAKDOWN"
      ),
      REJECTION: analyzeGroup(
        snapshots,
        (s) => s.levels?.interactionType === "REJECTION"
      ),
      BOUNCE: analyzeGroup(
        snapshots,
        (s) => s.levels?.interactionType === "BOUNCE"
      ),
      NONE: analyzeGroup(
        snapshots,
        (s) => !s.levels?.interactionType
      ),
    },
    volumeRanges: {
      surge_3x: analyzeGroup(
        snapshots,
        (s) => (s.indicators?.volumeRatio ?? 0) >= 3
      ),
      elevated_2x: analyzeGroup(
        snapshots,
        (s) =>
          (s.indicators?.volumeRatio ?? 0) >= 2 &&
          (s.indicators?.volumeRatio ?? 0) < 3
      ),
      normal_1_5x: analyzeGroup(
        snapshots,
        (s) =>
          (s.indicators?.volumeRatio ?? 0) >= 1.5 &&
          (s.indicators?.volumeRatio ?? 0) < 2
      ),
      weak: analyzeGroup(
        snapshots,
        (s) => (s.indicators?.volumeRatio ?? 0) < 1.5
      ),
    },
    timeWindows: {
      open_930_1000: analyzeGroup(
        snapshots,
        (s) => (s.sessionMinute ?? 0) <= 30
      ),
      morning_1000_1130: analyzeGroup(
        snapshots,
        (s) =>
          (s.sessionMinute ?? 0) > 30 && (s.sessionMinute ?? 0) <= 120
      ),
      midday_1130_200: analyzeGroup(
        snapshots,
        (s) =>
          (s.sessionMinute ?? 0) > 120 && (s.sessionMinute ?? 0) <= 270
      ),
      afternoon_200_400: analyzeGroup(
        snapshots,
        (s) => (s.sessionMinute ?? 0) > 270
      ),
    },
    gexRegime: {
      negative_gex: analyzeGroup(
        snapshots,
        (s) => s.market?.gexRegime === "NEGATIVE"
      ),
      positive_gex: analyzeGroup(
        snapshots,
        (s) => s.market?.gexRegime === "POSITIVE"
      ),
    },
    allEngines: analyzeGroup(
      snapshots,
      (s) => s.ignition?.allEnginesFiring === true
    ),
    tfAlignment: {
      high_80plus: analyzeGroup(
        snapshots,
        (s) => (s.indicators?.tfAlignScore ?? 0) >= 80
      ),
      medium_60_80: analyzeGroup(
        snapshots,
        (s) =>
          (s.indicators?.tfAlignScore ?? 0) >= 60 &&
          (s.indicators?.tfAlignScore ?? 0) < 80
      ),
      low: analyzeGroup(
        snapshots,
        (s) => (s.indicators?.tfAlignScore ?? 0) < 60
      ),
    },
    byTicker: {},
  };
}

function finalizePatterns(patterns, snapshots) {
  const tickerGroups = {};
  for (const s of snapshots) {
    if (!s.ticker) continue;
    if (!tickerGroups[s.ticker]) tickerGroups[s.ticker] = [];
    tickerGroups[s.ticker].push(s);
  }
  const out = { ...patterns };
  out.byTicker = {};
  for (const [ticker, snaps] of Object.entries(tickerGroups)) {
    out.byTicker[ticker] = analyzeGroup(snaps, () => true);
  }
  return out;
}

function mergeBuckets(a, b) {
  if (!a) return b;
  if (!b) return a;
  const wins = (a.wins || 0) + (b.wins || 0);
  const total = (a.total || 0) + (b.total || 0);
  const count = (a.count || 0) + (b.count || 0);
  const ca = a.avgReturn != null && a.count ? a.avgReturn * a.count : 0;
  const cb = b.avgReturn != null && b.count ? b.avgReturn * b.count : 0;
  const nRet = (a.avgReturn != null ? a.count || 0 : 0) + (b.avgReturn != null ? b.count || 0 : 0);
  const avgReturn = nRet > 0 ? +((ca + cb) / nRet).toFixed(1) : null;
  return {
    count,
    wins,
    losses: (a.losses || 0) + (b.losses || 0),
    total,
    winRate: total > 0 ? Math.round((wins / total) * 100) : null,
    avgReturn,
  };
}

function mergeNested(oldP, newP) {
  if (!oldP) return newP;
  if (!newP) return oldP;
  const out = { ...oldP };
  for (const key of Object.keys(newP)) {
    const o = oldP[key];
    const n = newP[key];
    if (n && typeof n === "object" && n.winRate !== undefined && n.count !== undefined) {
      out[key] = mergeBuckets(o, n);
    } else if (n && typeof n === "object" && !Array.isArray(n)) {
      out[key] = mergeNested(o || {}, n);
    }
  }
  return out;
}

function mergePatterns(allPatterns, todayPatterns) {
  return mergeNested(allPatterns || {}, todayPatterns || {});
}

function flattenPatternLeaves(patterns, prefix = "") {
  const rows = [];
  if (!patterns || typeof patterns !== "object") return rows;
  for (const [k, v] of Object.entries(patterns)) {
    const path = prefix ? `${prefix} / ${k}` : k;
    if (v && typeof v === "object" && v.winRate != null && v.count != null) {
      rows.push({ name: path, winRate: v.winRate, count: v.count });
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      rows.push(...flattenPatternLeaves(v, path));
    }
  }
  return rows;
}

function getTopPatterns(patterns, minCount = 5, limit = 8) {
  return flattenPatternLeaves(patterns)
    .filter((r) => r.count >= minCount && r.winRate != null)
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, limit);
}

function getBottomPatterns(patterns, minCount = 5, limit = 8) {
  return flattenPatternLeaves(patterns)
    .filter((r) => r.count >= minCount && r.winRate != null)
    .sort((a, b) => a.winRate - b.winRate)
    .slice(0, limit);
}

function formatPatterns(patterns) {
  if (!patterns || typeof patterns !== "object") return "(none)";
  try {
    return JSON.stringify(patterns, null, 2).slice(0, 12000);
  } catch {
    return String(patterns);
  }
}

function generateImprovements(patterns, allTimePatterns, totalDays) {
  const suggestions = [];
  const at = allTimePatterns || patterns;

  const ign50 = at?.ignitionRanges?.["50-64"];
  if (ign50?.count >= 10 && ign50?.winRate != null && ign50.winRate < 50) {
    suggestions.push({
      type: "THRESHOLD_ADJUST",
      component: "Ignition Score",
      current: 65,
      suggested: 70,
      reason: `Ignition 50-64 signals have only ${ign50.winRate}% win rate (${ign50.count} signals). Raise minimum threshold to 70.`,
      impact: "HIGH",
      dataPoints: ign50.count,
    });
  }

  const volWeak = at?.volumeRanges?.weak;
  if (volWeak?.count >= 10 && volWeak?.winRate != null && volWeak.winRate < 45) {
    suggestions.push({
      type: "THRESHOLD_ADJUST",
      component: "Volume Ratio",
      current: 1.5,
      suggested: 2.0,
      reason: `Signals with volume < 1.5x have only ${volWeak.winRate}% win rate. Require 2x+ volume for alerts.`,
      impact: "HIGH",
      dataPoints: volWeak.count,
    });
  }

  const midday = at?.timeWindows?.midday_1130_200;
  if (midday?.count >= 10 && midday?.winRate != null && midday.winRate < 50) {
    suggestions.push({
      type: "TIME_FILTER",
      component: "Scanner Hours",
      current: "All day",
      suggested: "Skip 11:30am-2pm",
      reason: `Midday signals (11:30-2pm) have only ${midday.winRate}% win rate. This is the lunch chop zone.`,
      impact: "MEDIUM",
      dataPoints: midday.count,
    });
  }

  const posGEX = at?.gexRegime?.positive_gex;
  const negGEX = at?.gexRegime?.negative_gex;
  if (posGEX?.count >= 10 && negGEX?.count >= 10) {
    const diff = (negGEX?.winRate || 0) - (posGEX?.winRate || 0);
    if (diff > 15) {
      suggestions.push({
        type: "CONTEXT_FILTER",
        component: "GEX Filter",
        current: "Alerts in all GEX regimes",
        suggested: "Prefer negative GEX for entries",
        reason: `Negative GEX signals win ${negGEX.winRate}% vs positive GEX ${posGEX.winRate}%.`,
        impact: "MEDIUM",
        dataPoints: posGEX.count + negGEX.count,
      });
    }
  }

  Object.entries(at?.levelTypes || {}).forEach(([type, data]) => {
    if (data?.count >= 5 && data?.winRate != null && data.winRate < 45) {
      suggestions.push({
        type: "SIGNAL_FILTER",
        component: `Level: ${type}`,
        current: `Sending ${type} alerts`,
        suggested: `Filter out ${type} signals`,
        reason: `${type} signals only ${data.winRate}% accurate (${data.count} signals).`,
        impact: "MEDIUM",
        dataPoints: data.count,
      });
    }
  });

  const impactScore = { HIGH: 3, MEDIUM: 2, LOW: 1 };
  suggestions.sort((a, b) => {
    return (
      (impactScore[b.impact] || 0) - (impactScore[a.impact] || 0) ||
      (b.dataPoints || 0) - (a.dataPoints || 0)
    );
  });

  void totalDays;
  return suggestions;
}

module.exports = {
  analyzePatterns,
  finalizePatterns,
  mergePatterns,
  mergeBuckets,
  getTopPatterns,
  getBottomPatterns,
  formatPatterns,
  generateImprovements,
  flattenPatternLeaves,
};
