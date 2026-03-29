const REGIMES = {
  TRENDING_BULL: "trending_bull",
  TRENDING_BEAR: "trending_bear",
  CHOPPY: "choppy",
  VOLATILE: "volatile",
  LOW_VOL_GRIND: "low_vol_grind",
  RISK_OFF: "risk_off",
  RISK_ON: "risk_on",
};

function calculateRegime(marketData) {
  const {
    vix = 18,
    spyChange = 0,
    qqqChange = 0,
    spyAdx = 20,
    spyRsi = 50,
    spyVwapDist = 0,
    putCallRatio = null,
    spyVolRatio = 1,
  } = marketData;

  const vixRegime =
    vix < 15
      ? "low_vol"
      : vix < 20
        ? "normal"
        : vix < 25
          ? "elevated"
          : vix < 30
            ? "high"
            : "extreme";

  const trendRegime =
    spyAdx > 28 && spyChange > 0
      ? "strong_bull"
      : spyAdx > 28 && spyChange < 0
        ? "strong_bear"
        : spyAdx > 22
          ? "moderate_trend"
          : "choppy";

  const riskRegime =
    spyChange > 0.5 && qqqChange > 0.5
      ? "risk_on"
      : spyChange < -0.5 && qqqChange < -0.5
        ? "risk_off"
        : "neutral";

  let primaryRegime;
  if (vixRegime === "extreme") primaryRegime = REGIMES.VOLATILE;
  else if (vixRegime === "high" && riskRegime === "risk_off")
    primaryRegime = REGIMES.RISK_OFF;
  else if (trendRegime === "strong_bull") primaryRegime = REGIMES.TRENDING_BULL;
  else if (trendRegime === "strong_bear") primaryRegime = REGIMES.TRENDING_BEAR;
  else if (trendRegime === "choppy") primaryRegime = REGIMES.CHOPPY;
  else if (vixRegime === "low_vol") primaryRegime = REGIMES.LOW_VOL_GRIND;
  else primaryRegime = REGIMES.RISK_ON;

  const thresholds = {
    minADX:
      primaryRegime === REGIMES.LOW_VOL_GRIND
        ? 20
        : primaryRegime === REGIMES.VOLATILE
          ? 30
          : 25,
    minScore:
      primaryRegime === REGIMES.TRENDING_BULL ||
      primaryRegime === REGIMES.TRENDING_BEAR
        ? 72
        : primaryRegime === REGIMES.CHOPPY
          ? 88
          : 78,
    fireAlertScore:
      primaryRegime === REGIMES.TRENDING_BULL ||
      primaryRegime === REGIMES.TRENDING_BEAR
        ? 85
        : 92,
    maxRSIForCalls: primaryRegime === REGIMES.VOLATILE ? 68 : 72,
    minRSIForPuts: primaryRegime === REGIMES.VOLATILE ? 32 : 28,
    preferredStrategy: vix > 25 ? "spread" : "outright",
    sizeMultiplier:
      primaryRegime === REGIMES.TRENDING_BULL ||
      primaryRegime === REGIMES.TRENDING_BEAR
        ? 1.5
        : primaryRegime === REGIMES.CHOPPY
          ? 0.5
          : 1.0,
    confidenceBoost:
      riskRegime === "risk_on" ? 8 : riskRegime === "risk_off" ? -8 : 0,
  };

  return {
    primary: primaryRegime,
    vixRegime,
    trendRegime,
    riskRegime,
    thresholds,
    description: getRegimeDescription(primaryRegime, vix, spyChange),
    tradingAdvice: getRegimeTradingAdvice(primaryRegime, thresholds),
    putCallRatio,
    spyVolRatio,
    spyRsi,
    spyVwapDist,
  };
}

function getRegimeDescription(regime, vix, spyChange) {
  const chg = Number(spyChange) || 0;
  const descriptions = {
    trending_bull: `Strong bull trend. SPY ${chg >= 0 ? "+" : ""}${chg.toFixed(1)}%. Bulls in control. Good day for calls.`,
    trending_bear: `Strong bear trend. Market selling off. Good day for puts on weak stocks.`,
    choppy: `Choppy market. No clear direction. Be very selective — only A+ setups.`,
    volatile: `High volatility (VIX ${Number(vix).toFixed(1)}). Use spreads only. Reduce size. Expect whipsaws.`,
    low_vol_grind: `Low volatility grind. Premium cheap. Trend plays working well.`,
    risk_off: `Risk-off session. Defensive. Puts on weak names. Avoid momentum longs.`,
    risk_on: `Risk-on session. Momentum working. Favor calls on strong names.`,
  };
  return descriptions[regime] || "Mixed conditions.";
}

function getRegimeTradingAdvice(regime, thresholds) {
  return {
    minScore: thresholds.minScore,
    fireAlertScore: thresholds.fireAlertScore,
    strategy: thresholds.preferredStrategy,
    sizeMultiplier: thresholds.sizeMultiplier,
    minADX: thresholds.minADX,
  };
}

module.exports = { calculateRegime, REGIMES };
