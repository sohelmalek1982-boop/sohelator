function calculateUrgency(setup, regime, memory) {
  const { score, stage, indicators, option } = setup;

  let urgencyScore = 0;
  const reasons = [];

  urgencyScore += score * 0.4;

  const stageWeights = {
    bull: 25,
    bear: 25,
    setup_bull: 10,
    setup_bear: 10,
    fading: 5,
    reversal: 15,
    chop: -50,
  };
  urgencyScore += stageWeights[stage] || 0;

  if (score >= 90) {
    urgencyScore += 20;
    reasons.push("All signals strongly aligned");
  }

  const volRatio = Number(indicators?.volRatio) || 0;
  if (volRatio >= 3) {
    urgencyScore += 15;
    reasons.push(`Volume ${volRatio.toFixed(1)}x average`);
  } else if (volRatio >= 2) {
    urgencyScore += 8;
    reasons.push(`Volume ${volRatio.toFixed(1)}x average`);
  }

  if (setup.hasNewsCatalyst) {
    urgencyScore += 15;
    reasons.push("News catalyst confirmed");
  }

  const ivNum = parseFloat(option?.iv);
  if (option?.iv != null && !isNaN(ivNum) && ivNum < 35) {
    urgencyScore += 10;
    reasons.push(`IV cheap at ${ivNum.toFixed(0)}%`);
  }

  const liqTier = option?.liquidity?.tier;
  if (liqTier === "A") {
    urgencyScore += 12;
    reasons.push("Option liquidity tier A — tradeable spread + OI");
  } else if (liqTier === "B") {
    urgencyScore += 7;
    reasons.push("Option liquidity tier B");
  } else if (liqTier === "C") {
    urgencyScore += 3;
  }

  const adxNum = parseFloat(indicators?.adx);
  if (!isNaN(adxNum) && adxNum > 30) {
    urgencyScore += 8;
    reasons.push(`ADX strong at ${adxNum.toFixed(1)}`);
  }

  if (regime.riskRegime === "risk_on" && stage === "bull") {
    urgencyScore += 10;
    reasons.push("Broad market confirming bull");
  }
  if (regime.riskRegime === "risk_off" && stage === "bear") {
    urgencyScore += 10;
    reasons.push("Broad market confirming bear");
  }

  const tickerStats = memory?.allTickerStats?.find(
    (t) => t.ticker === setup.ticker
  );
  if (
    tickerStats &&
    tickerStats.winRate >= 70 &&
    tickerStats.totalTrades >= 3
  ) {
    urgencyScore += 12;
    reasons.push(`You win ${tickerStats.winRate}% on ${setup.ticker}`);
  }

  const patternStats = memory?.allPatternStats?.find(
    (p) => p.stage === stage
  );
  if (
    patternStats &&
    patternStats.winRate >= 70 &&
    patternStats.totalTrades >= 3
  ) {
    urgencyScore += 10;
    reasons.push(`Your ${stage} win rate: ${patternStats.winRate}%`);
  }

  if (memory?.behavioralStats) {
    const day = new Date().toLocaleDateString("en-US", { weekday: "short" });
    const dayTrades = memory.behavioralStats.tradesByDayOfWeek?.[day];
    const dayWins = memory.behavioralStats.winsByDayOfWeek?.[day];
    if (dayTrades >= 3) {
      const dayWR = Math.round((dayWins / dayTrades) * 100);
      if (dayWR < 40) urgencyScore -= 10;
    }
  }

  let tier;
  let emoji;
  let label;
  let sendPush;

  if (urgencyScore >= 88) {
    tier = "FIRE";
    emoji = "🔥🔥🔥";
    label = "FIRE ALERT — BUY NOW";
    sendPush = true;
  } else if (urgencyScore >= 75) {
    tier = "STRONG";
    emoji = "⚡⚡";
    label = "STRONG SETUP";
    sendPush = true;
  } else if (urgencyScore >= 60) {
    tier = "WATCH";
    emoji = "👀";
    label = "SETUP FORMING";
    sendPush = false;
  } else {
    tier = "INFO";
    emoji = "📊";
    label = "INFO";
    sendPush = false;
  }

  return {
    tier,
    emoji,
    label,
    urgencyScore: Math.round(urgencyScore),
    reasons,
    sendPush,
  };
}

function buildTelegramMessage(setup, urgency, regime, memory, retestEntry) {
  const { tier, emoji, label } = urgency;
  const { ticker, stage, stageLabel, score, winRate, option, indicators } =
    setup;

  const tickerStats = memory?.allTickerStats?.find((t) => t.ticker === ticker);
  const memoryLine =
    tickerStats && tickerStats.totalTrades >= 3
      ? `📈 Your ${ticker} record: ${tickerStats.winRate}% win rate (${tickerStats.totalTrades} trades)\n`
      : "";

  const retestLine =
    retestEntry?.shouldWait && retestEntry.retestPrice
      ? `\n⏳ <i>Better entry near $${Number(retestEntry.retestPrice).toFixed(2)} — ${retestEntry.message}</i>`
      : "";

  const mult = regime.thresholds?.sizeMultiplier ?? 1;
  const sizeRec =
    mult > 1.2
      ? "📐 SIZE: Consider larger position — strong regime"
      : mult < 0.8
        ? "📐 SIZE: Reduce size — choppy conditions"
        : "📐 SIZE: Normal position";

  const macdVal = parseFloat(indicators?.macd);
  const vwapD = parseFloat(indicators?.vwapDist);
  const midStr =
    option?.mid != null
      ? typeof option.mid === "number"
        ? option.mid.toFixed(2)
        : String(option.mid)
      : "—";

  if (tier === "FIRE") {
    return (
      `${emoji} <b>${label}</b> ${emoji}\n\n` +
      `<b>${ticker} — ${stageLabel}</b>\n` +
      `Score: ${score}/100 | Win Rate: ${winRate != null ? winRate : "—"}%\n\n` +
      urgency.reasons.map((r) => `✅ ${r}`).join("\n") +
      "\n\n" +
      `📊 ADX: ${parseFloat(indicators.adx).toFixed(1)} | RSI: ${parseFloat(indicators.rsi).toFixed(1)} | MACD: ${macdVal >= 0 ? "+" : ""}${macdVal.toFixed(3)}\n` +
      `VWAP: ${vwapD > 0 ? "Above" : "Below"} (${vwapD.toFixed(2)}%)\n\n` +
      `🎯 <b>BUY: ${option?.strike} exp ${option?.expiry} @ $${midStr}</b>\n` +
      `Delta: ${option?.delta} | IV: ${option?.iv}%\n` +
      `${retestLine}\n\n` +
      `${memoryLine}` +
      `${sizeRec}\n` +
      `⚠️ Stop: -40% | Target: +80-150%\n` +
      `🏷️ ${regime.description || ""}`
    );
  }

  if (tier === "STRONG") {
    return (
      `${emoji} <b>${label} — ${ticker}</b>\n\n` +
      `${stageLabel} | Score: ${score}/100\n` +
      urgency.reasons
        .slice(0, 3)
        .map((r) => `✅ ${r}`)
        .join("\n") +
      "\n\n" +
      `🎯 ${option?.strike} @ $${midStr} | ${option?.expiry}\n` +
      `${retestLine}\n` +
      `${memoryLine}` +
      `Stop: -40% | Target: +80%`
    );
  }

  if (tier === "WATCH") {
    return (
      `${emoji} <b>WATCH — ${ticker}</b>\n` +
      `${stageLabel} forming. Score: ${score}/100\n` +
      `${urgency.reasons[0] || "Setup building"}\n` +
      `Get your order ready — not an entry yet.`
    );
  }

  return null;
}

module.exports = { calculateUrgency, buildTelegramMessage };
