const { tradierGet, normList } = require("./tradierClient");
const { getFullTimeframeAnalysis } = require("./multiTimeframe");
const { calculateGEX } = require("./gex");
const { analyzeOptionsFlow } = require("./optionsFlow");
const { calculateMarketProfile } = require("./marketProfile");
const { calculateKeyLevels } = require("./levels");
const { calculateAdvancedMomentum } = require("./momentum");
const { analyzeSectorContext } = require("./sectorCorrelation");
const { selectOptimalStrike } = require("./strikeSelector");
const { checkEarnings } = require("./earnings");
const { calculateRegime } = require("./marketRegime");
const { getMemoryContext } = require("./memory");

async function fetchNearestChain(symbol) {
  const expData = await tradierGet("/v1/markets/options/expirations", {
    symbol,
    includeAllRoots: "true",
  });
  const dates = normList(expData.expirations?.date).map(String).sort();
  let pick = null;
  for (const e of dates) {
    const t = new Date(e + "T12:00:00");
    const dte = Math.round((t - Date.now()) / 86400000);
    if (dte >= 5 && dte <= 21) {
      pick = e;
      break;
    }
  }
  if (!pick && dates.length) pick = dates[0];
  if (!pick) return { expiration: null, chain: [] };
  const chainData = await tradierGet("/v1/markets/options/chains", {
    symbol,
    expiration: pick,
    greeks: "true",
  });
  return {
    expiration: pick,
    chain: normList(chainData.options?.option),
  };
}

async function buildRegime(tfDaily) {
  try {
    const qd = await tradierGet("/v1/markets/quotes", {
      symbols: "SPY,QQQ,VIX",
      greeks: "false",
    });
    const ql = normList(qd.quotes?.quote);
    const map = {};
    for (const q of ql) map[q.symbol] = q;
    const spy = map.SPY;
    const qqq = map.QQQ;
    const vix = map.VIX;
    const spyPrev = parseFloat(spy?.prevclose ?? 0);
    const qqqPrev = parseFloat(qqq?.prevclose ?? 0);
    const spyLast = parseFloat(spy?.last ?? spy?.close ?? 0);
    const qqqLast = parseFloat(qqq?.last ?? qqq?.close ?? 0);
    const spyChange = spyPrev ? ((spyLast - spyPrev) / spyPrev) * 100 : 0;
    const qqqChange = qqqPrev ? ((qqqLast - qqqPrev) / qqqPrev) * 100 : 0;
    return calculateRegime({
      vix: parseFloat(vix?.last ?? vix?.close ?? 18) || 18,
      spyChange,
      qqqChange,
      spyAdx: tfDaily?.adx ?? 22,
      spyRsi: tfDaily?.rsi ?? 50,
      spyVwapDist: 0,
    });
  } catch {
    return calculateRegime({});
  }
}

function buildClaudeContext(
  symbol,
  price,
  _quote,
  tf,
  flow,
  gex,
  profile,
  levels,
  momentum,
  sector,
  earnings,
  memory,
  confidence,
  strike
) {
  const lines = [];
  lines.push(`━━ ${symbol} MASTER ANALYSIS ━━`);
  lines.push(`Price: $${price.toFixed(2)}`);
  lines.push(`Confidence: ${confidence}/100`);
  lines.push(`Bias: ${tf?.tradingBias || "NEUTRAL"}`);
  lines.push("");

  if (tf) {
    lines.push("TIMEFRAME ALIGNMENT:");
    lines.push(
      `Daily: ${tf.daily?.trend} (ADX: ${Number(tf.daily?.adx).toFixed(1)}, RSI: ${Number(tf.daily?.rsi).toFixed(1)})`
    );
    lines.push(
      `4H: ${tf.fourHour?.trend} | 1H: ${tf.oneHour?.trend}`
    );
    lines.push(
      `15M: ${tf.fifteenMin?.trend} | 5M: ${tf.fiveMin?.trend}`
    );
    lines.push(
      `Weighted alignment: ${tf.alignmentScore}/100 (${tf.confluenceLevel})`
    );
    lines.push("");
  }

  if (gex) {
    lines.push("GAMMA EXPOSURE (GEX):");
    lines.push(`GEX Regime: ${gex.gexRegime} (${gex.interpretation})`);
    if (gex.gexFlipLevel) {
      lines.push(
        `GEX Flip Level: $${gex.gexFlipLevel} ${gex.tradingImplication?.flipWarning || ""}`
      );
    }
    if (gex.gexResistance) {
      lines.push(`GEX Resistance: $${gex.gexResistance?.strike}`);
    }
    if (gex.gexSupport) {
      lines.push(`GEX Support: $${gex.gexSupport?.strike}`);
    }
    lines.push("");
  }

  if (flow) {
    lines.push("OPTIONS FLOW:");
    lines.push(flow.flowSummary);
    lines.push("");
  }

  if (profile) {
    lines.push("MARKET PROFILE:");
    lines.push(
      `POC: $${profile.poc?.toFixed(2)} | VAH: ${profile.vah?.toFixed(2)} | VAL: ${profile.val?.toFixed(2)}`
    );
    lines.push(`Price position: ${profile.pricePosition}`);
    lines.push(profile.interpretation);
    lines.push("");
  }

  if (levels) {
    lines.push("KEY PRICE LEVELS:");
    lines.push(levels.summary);
    if (levels.nearResistanceWarning) {
      lines.push(levels.nearResistanceWarning);
    }
    lines.push("");
  }

  if (momentum) {
    lines.push("ADVANCED MOMENTUM:");
    lines.push(momentum.interpretation);
    lines.push(
      `Expected move: +/-$${momentum.atr?.toFixed(2)} (${momentum.atrPct}%)`
    );
    lines.push(`Optimal call strike: $${momentum.optimalCallStrike}`);
    lines.push(`Optimal put strike: $${momentum.optimalPutStrike}`);
    lines.push("");
  }

  if (sector) {
    lines.push("SECTOR CONTEXT:");
    lines.push(sector.sectorAdvice);
    lines.push(`Market breadth: ${sector.marketBreadth}`);
    lines.push(`Macro signal: ${sector.macroSignal}`);
    lines.push(
      `Top sectors: ${sector.topSectors
        .map(
          (s) =>
            `${s.name} ${s.change > 0 ? "+" : ""}${s.change.toFixed(2)}%`
        )
        .join(", ")}`
    );
    lines.push("");
  }

  if (earnings?.hasEarnings) {
    lines.push("EARNINGS:");
    lines.push(
      earnings.warning || `Earnings in ${earnings.daysToEarnings} days`
    );
    lines.push("");
  }

  if (memory?.insights?.length) {
    lines.push("SOHEL'S PERSONAL EDGE:");
    memory.insights.forEach((i) => lines.push(`• ${i}`));
    lines.push("");
  }

  if (strike?.primary) {
    lines.push("OPTIMAL STRIKE:");
    lines.push(strike.reasoning);
    lines.push("");
  }

  return lines.join("\n");
}

function buildOneSummary(symbol, price, tf, flow, gex, sector, earnings, confidence) {
  if (earnings?.isThisWeek) {
    return `${symbol} — SKIP (earnings ${earnings.daysToEarnings}d)`;
  }
  const bias = tf?.tradingBias || "NEUTRAL";
  const align = tf?.alignmentScore || 0;
  const flowBias = flow?.smartMoneyBias || "NEUTRAL";
  const gexNote =
    gex?.gexRegime === "NEGATIVE" ? " GEX negative (explosive moves)" : "";
  const sectorNote = sector?.tailwind
    ? " Sector tailwind."
    : sector?.headwind
      ? " Sector headwind."
      : "";
  return `${symbol} $${price.toFixed(2)} — ${bias} (${align}% aligned). Flow: ${flowBias}.${gexNote}${sectorNote} Confidence: ${confidence}/100`;
}

/**
 * Full institutional context for one underlying.
 * @param {string} symbol
 */
async function getMasterAnalysis(symbol) {
  const sym = String(symbol || "").toUpperCase();
  if (!sym) return null;

  const qd = await tradierGet("/v1/markets/quotes", {
    symbols: sym,
    greeks: "false",
  });
  const rawQ = qd.quotes?.quote;
  const quote = Array.isArray(rawQ) ? rawQ[0] : rawQ;
  const price =
    parseFloat(quote?.last ?? quote?.close ?? quote?.bid ?? 0) || 0;
  if (!price) return null;

  const tfData = await getFullTimeframeAnalysis(sym);
  const fiveMin = tfData.rawFiveMin || [];
  const closes = fiveMin.map((c) => c.close);

  const [flowRes, sectorRes, earningsRes, memoryRes, chainPack, regime] =
    await Promise.all([
      analyzeOptionsFlow(sym, price).catch(() => null),
      analyzeSectorContext(sym).catch(() => null),
      checkEarnings(sym).catch(() => ({ hasEarnings: false })),
      getMemoryContext(sym).catch(() => ({ insights: [] })),
      fetchNearestChain(sym).catch(() => ({ expiration: null, chain: [] })),
      buildRegime(tfData.daily),
    ]);

  let gex = null;
  try {
    gex = await calculateGEX(sym, price);
  } catch {
    gex = null;
  }

  const marketProfile =
    fiveMin.length >= 20 ? calculateMarketProfile(fiveMin) : null;

  const levels = tfData.rawDaily?.length
    ? calculateKeyLevels(tfData.rawDaily, tfData.rawHourly || [], price)
    : null;

  const momentum =
    closes.length >= 14
      ? calculateAdvancedMomentum(fiveMin, closes)
      : null;

  const bullish = tfData.weightedBull > tfData.weightedBear;
  const direction = bullish ? "bull" : "bear";
  const baseScore = Math.round(tfData.alignmentScore * 0.6 + 20);

  let optimalStrike = null;
  if (chainPack.chain?.length && momentum) {
    try {
      optimalStrike = await selectOptimalStrike(
        sym,
        direction,
        price,
        chainPack.chain,
        momentum,
        levels,
        baseScore,
        regime,
        2
      );
    } catch {
      optimalStrike = null;
    }
  }

  const flowData = flowRes;
  const sectorData = sectorRes;
  const earningsData = earningsRes;
  const memoryData = memoryRes;

  let confidence = 50;
  if (tfData.alignmentScore > 80) confidence += 15;
  else if (tfData.alignmentScore > 60) confidence += 8;

  if (
    flowData?.smartMoneyBias === "BULLISH" &&
    tfData.tradingBias === "BULL"
  ) {
    confidence += 10;
  }
  if (
    flowData?.smartMoneyBias === "BEARISH" &&
    tfData.tradingBias === "BEAR"
  ) {
    confidence += 10;
  }

  if (sectorData?.tailwind) confidence += 8;
  if (sectorData?.headwind) confidence -= 8;
  if (gex?.gexRegime === "NEGATIVE") confidence += 5;
  if (
    marketProfile?.pricePosition === "ABOVE_VALUE_AREA" &&
    tfData.tradingBias === "BULL"
  ) {
    confidence += 8;
  }
  if (earningsData?.isThisWeek) confidence -= 30;
  else if (earningsData?.isSoon) confidence -= 10;
  if (momentum?.momentumBias === tfData.tradingBias) confidence += 5;

  confidence += regime.thresholds?.confidenceBoost || 0;
  confidence = Math.max(0, Math.min(100, Math.round(confidence)));

  const claudeContext = buildClaudeContext(
    sym,
    price,
    quote,
    tfData,
    flowData,
    gex,
    marketProfile,
    levels,
    momentum,
    sectorData,
    earningsData,
    memoryData,
    confidence,
    optimalStrike
  );

  return {
    symbol: sym,
    price,
    confidence,
    tradingBias: tfData.tradingBias || "NEUTRAL",
    timeframes: tfData,
    optionsFlow: flowData,
    gex,
    marketProfile,
    levels,
    momentum,
    sector: sectorData,
    earnings: earningsData,
    memory: memoryData,
    optimalStrike,
    earningsWarning: earningsData?.warning,
    skipDueToEarnings: !!earningsData?.isThisWeek,
    recommendedOption: optimalStrike?.primary,
    claudeContext,
    summary: buildOneSummary(
      sym,
      price,
      tfData,
      flowData,
      gex,
      sectorData,
      earningsData,
      confidence
    ),
    regime,
    optionChainExpiration: chainPack.expiration,
  };
}

module.exports = {
  getMasterAnalysis,
  buildClaudeContext,
  buildOneSummary,
};
