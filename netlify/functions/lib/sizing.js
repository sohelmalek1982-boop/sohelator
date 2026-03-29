function recommendSize(setup, regime, memory, accountEquity) {
  const eq = Math.max(1, Number(accountEquity) || 1);
  const baseContracts = 1;
  let multiplier = 1.0;
  const reasons = [];

  const sm = regime.thresholds?.sizeMultiplier ?? 1;
  if (sm > 1) {
    multiplier *= sm;
    reasons.push(`${regime.primary} regime favors larger size`);
  } else if (sm < 1) {
    multiplier *= sm;
    reasons.push(`${regime.primary} regime — reduce size`);
  }

  if (setup.score >= 90) {
    multiplier *= 1.5;
    reasons.push("Very high conviction setup (90+)");
  } else if (setup.score >= 80) {
    multiplier *= 1.2;
    reasons.push("High conviction setup (80+)");
  } else if (setup.score < 70) {
    multiplier *= 0.7;
    reasons.push("Lower conviction — probe size only");
  }

  const tickerStats = memory?.allTickerStats?.find(
    (t) => t.ticker === setup.ticker
  );
  if (tickerStats?.totalTrades >= 5) {
    if (tickerStats.winRate >= 75) {
      multiplier *= 1.3;
      reasons.push(
        `Strong personal edge on ${setup.ticker} (${tickerStats.winRate}% WR)`
      );
    } else if (tickerStats.winRate <= 40) {
      multiplier *= 0.5;
      reasons.push(
        `Weak personal edge on ${setup.ticker} (${tickerStats.winRate}% WR) — small size`
      );
    }
  }

  const ivNum = parseFloat(setup.option?.iv);
  if (!isNaN(ivNum) && ivNum > 60) {
    multiplier *= 0.7;
    reasons.push("High IV — reduce size, use spread");
  }

  const premiumCost = (parseFloat(setup.option?.mid) || 5) * 100;
  const maxLossPerContract = premiumCost * 0.45;
  const maxTotalRisk = eq * 0.02;
  const maxContractsByRisk = Math.floor(maxTotalRisk / maxLossPerContract) || 1;

  const recommended = Math.max(
    1,
    Math.min(
      Math.round(baseContracts * multiplier),
      maxContractsByRisk,
      5
    )
  );

  const riskAmt = recommended * maxLossPerContract;

  return {
    recommended,
    multiplier: multiplier.toFixed(2),
    maxByRisk: maxContractsByRisk,
    reasons,
    riskAmount: riskAmt.toFixed(0),
    riskPct: ((riskAmt / eq) * 100).toFixed(1),
    strategy: regime.thresholds?.preferredStrategy || "outright",
    advice:
      recommended > 1
        ? `Consider ${recommended} contracts — higher conviction`
        : `1 contract — standard size`,
  };
}

module.exports = { recommendSize };
