async function forecastSetup(currentSnapshot, allTimePatterns) {
  if (!allTimePatterns) return null;

  const matches = [];
  let totalWeight = 0;
  let weightedWinRate = 0;

  const ignScore = currentSnapshot.ignition?.score || 0;
  const ignKey =
    ignScore >= 80 ? "80-100" : ignScore >= 65 ? "65-79" : ignScore >= 50 ? "50-64" : "below50";
  const ignPattern = allTimePatterns?.ignitionRanges?.[ignKey];
  if (ignPattern?.winRate != null && ignPattern.count >= 5) {
    const weight = 3;
    matches.push({
      condition: `Ignition ${ignKey}`,
      winRate: ignPattern.winRate,
      count: ignPattern.count,
      weight,
    });
    weightedWinRate += ignPattern.winRate * weight;
    totalWeight += weight;
  }

  const levelType = currentSnapshot.levels?.interactionType;
  if (levelType) {
    const levelPattern = allTimePatterns?.levelTypes?.[levelType];
    if (levelPattern?.winRate != null && levelPattern.count >= 3) {
      const weight = 3;
      matches.push({
        condition: `Level: ${levelType}`,
        winRate: levelPattern.winRate,
        count: levelPattern.count,
        weight,
      });
      weightedWinRate += levelPattern.winRate * weight;
      totalWeight += weight;
    }
  }

  const volRatio = currentSnapshot.indicators?.volumeRatio || 1;
  const volKey =
    volRatio >= 3
      ? "surge_3x"
      : volRatio >= 2
        ? "elevated_2x"
        : volRatio >= 1.5
          ? "normal_1_5x"
          : "weak";
  const volPattern = allTimePatterns?.volumeRanges?.[volKey];
  if (volPattern?.winRate != null && volPattern.count >= 5) {
    const weight = 2;
    matches.push({
      condition: `Volume ${volKey}`,
      winRate: volPattern.winRate,
      count: volPattern.count,
      weight,
    });
    weightedWinRate += volPattern.winRate * weight;
    totalWeight += weight;
  }

  const sessionMin = currentSnapshot.sessionMinute || 0;
  const timeKey =
    sessionMin <= 30
      ? "open_930_1000"
      : sessionMin <= 120
        ? "morning_1000_1130"
        : sessionMin <= 270
          ? "midday_1130_200"
          : "afternoon_200_400";
  const timePattern = allTimePatterns?.timeWindows?.[timeKey];
  if (timePattern?.winRate != null && timePattern.count >= 5) {
    const weight = 1.5;
    matches.push({
      condition: `Time: ${timeKey}`,
      winRate: timePattern.winRate,
      count: timePattern.count,
      weight,
    });
    weightedWinRate += timePattern.winRate * weight;
    totalWeight += weight;
  }

  if (currentSnapshot.ignition?.allEnginesFiring) {
    const engPattern = allTimePatterns?.allEngines;
    if (engPattern?.winRate != null && engPattern.count >= 3) {
      const weight = 2;
      matches.push({
        condition: "All 3 engines firing",
        winRate: engPattern.winRate,
        count: engPattern.count,
        weight,
      });
      weightedWinRate += engPattern.winRate * weight;
      totalWeight += weight;
    }
  }

  const tickerPattern = allTimePatterns?.byTicker?.[currentSnapshot.ticker];
  if (tickerPattern?.winRate != null && tickerPattern.count >= 5) {
    const weight = 2;
    matches.push({
      condition: `${currentSnapshot.ticker} history`,
      winRate: tickerPattern.winRate,
      count: tickerPattern.count,
      weight,
    });
    weightedWinRate += tickerPattern.winRate * weight;
    totalWeight += weight;
  }

  if (matches.length === 0 || totalWeight === 0) return null;

  const forecastWinRate = Math.round(weightedWinRate / totalWeight);

  const totalDataPoints = matches.reduce((sum, m) => sum + m.count, 0);

  const forecastConfidence =
    totalDataPoints >= 50
      ? "HIGH"
      : totalDataPoints >= 20
        ? "MEDIUM"
        : totalDataPoints >= 10
          ? "LOW"
          : "INSUFFICIENT DATA";

  const recommendation =
    forecastWinRate >= 70 && forecastConfidence !== "INSUFFICIENT DATA"
      ? "HIGH CONVICTION — take full size"
      : forecastWinRate >= 60
        ? "MODERATE — normal size"
        : forecastWinRate >= 50
          ? "LOW — small size or skip"
          : "SKIP — below 50% historical win rate";

  return {
    forecastWinRate,
    forecastConfidence,
    totalDataPoints,
    matches,
    recommendation,
    summary:
      `Based on ${totalDataPoints} similar historical setups: ` +
      `${forecastWinRate}% win rate. ` +
      `${recommendation}.`,
    bestMatch: [...matches].sort((a, b) => b.winRate - a.winRate)[0],
    warnings: matches
      .filter((m) => m.winRate < 45 && m.count >= 5)
      .map(
        (m) =>
          `${m.condition} has only ${m.winRate}% win rate in your history`
      ),
  };
}

module.exports = { forecastSetup };
