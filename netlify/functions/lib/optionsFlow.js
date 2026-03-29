const { tradierGet, normList } = require("./tradierClient");

function calculateMaxPain(oiLevels, currentPrice) {
  if (!oiLevels.length) return null;
  const strikes = [...new Set(oiLevels.map((l) => l.strike))].sort(
    (a, b) => a - b
  );
  let minPain = Infinity;
  let maxPainStrike = currentPrice;
  for (const testStrike of strikes) {
    let totalPain = 0;
    for (const level of oiLevels) {
      if (level.type === "call" && testStrike > level.strike) {
        totalPain += (testStrike - level.strike) * level.oi;
      }
      if (level.type === "put" && testStrike < level.strike) {
        totalPain += (level.strike - testStrike) * level.oi;
      }
    }
    if (totalPain < minPain) {
      minPain = totalPain;
      maxPainStrike = testStrike;
    }
  }
  return maxPainStrike;
}

function buildFlowSummary(
  flowSentiment,
  smartMoney,
  unusualCalls,
  unusualPuts,
  maxPain,
  price,
  skew
) {
  const lines = [];
  lines.push(`Options Flow: ${flowSentiment}`);
  lines.push(`Smart money bias: ${smartMoney}`);
  if (unusualCalls[0]) {
    lines.push(
      `Unusual call buying: ${unusualCalls[0].strike} strike ${unusualCalls[0].expiration} (${unusualCalls[0].volume} contracts, $${unusualCalls[0].premiumPaid} premium)`
    );
  }
  if (unusualPuts[0]) {
    lines.push(
      `Unusual put buying: ${unusualPuts[0].strike} strike ${unusualPuts[0].expiration} (${unusualPuts[0].volume} contracts)`
    );
  }
  if (maxPain) {
    const distPct = (((maxPain - price) / price) * 100).toFixed(1);
    lines.push(`Max pain: $${maxPain} (${distPct}% from current price)`);
  }
  lines.push(`IV Skew: ${skew}`);
  return lines.join("\n");
}

async function analyzeOptionsFlow(symbol, price) {
  const p = +price || 0;
  if (!p) return null;

  const expData = await tradierGet("/v1/markets/options/expirations", {
    symbol,
  });
  const exps = expData.expirations?.date;
  const expList = normList(exps).map(String).filter(Boolean);
  const today = new Date();

  const nearExps = expList
    .filter(
      (d) => (new Date(d + "T12:00:00") - today) / 86400000 <= 21
    )
    .slice(0, 3);

  let totalCallVolume = 0;
  let totalPutVolume = 0;
  let totalCallOI = 0;
  let totalPutOI = 0;
  const unusualActivity = [];
  const largeOpenInterest = [];
  const skewData = [];

  for (const exp of nearExps) {
    const chainData = await tradierGet("/v1/markets/options/chains", {
      symbol,
      expiration: exp,
      greeks: "true",
    });
    const options = chainData.options?.option;
    if (!options) continue;
    const chain = normList(options);
    const avgVol =
      chain.reduce((s, o) => s + +(o.volume || 0), 0) /
      (chain.length || 1);

    for (const opt of chain) {
      const vol = +(opt.volume || 0);
      const oi = +(opt.open_interest || 0);
      const strike = +(opt.strike || 0);
      const iv = +(opt.greeks?.mid_iv || 0) * 100;
      const delta = +(opt.greeks?.delta || 0);
      const bid = +opt.bid || 0;
      const ask = +opt.ask || 0;
      const mid = bid && ask ? (bid + ask) / 2 : +opt.last || 0;

      if (opt.option_type === "call") {
        totalCallVolume += vol;
        totalCallOI += oi;
      } else {
        totalPutVolume += vol;
        totalPutOI += oi;
      }

      const volOiRatio = oi > 0 ? vol / oi : 0;
      if (vol > avgVol * 5 && vol > 500) {
        unusualActivity.push({
          symbol: opt.symbol,
          type: opt.option_type,
          strike,
          expiration: exp,
          volume: vol,
          openInterest: oi,
          volOiRatio: volOiRatio.toFixed(3),
          iv: iv.toFixed(1),
          mid: mid.toFixed(2),
          delta: delta.toFixed(2),
          distancePct: (((strike - p) / p) * 100).toFixed(2),
          isNewMoney: vol > oi * 0.5,
          premiumPaid: (vol * mid * 100).toLocaleString(),
          significance: vol > avgVol * 10 ? "VERY UNUSUAL" : "UNUSUAL",
        });
      }

      if (oi > 10000) {
        largeOpenInterest.push({
          strike,
          type: opt.option_type,
          expiration: exp,
          oi,
          isPinLevel: true,
        });
      }

      const moneyness = (strike - p) / p;
      skewData.push({ strike, moneyness, iv, type: opt.option_type, exp });
    }
  }

  const volumePCR = totalPutVolume / (totalCallVolume || 1);
  const oiPCR = totalPutOI / (totalCallOI || 1);

  const flowSentiment =
    volumePCR < 0.5
      ? "EXTREME BULLISH FLOW — contrarian warning"
      : volumePCR < 0.7
        ? "BULLISH FLOW"
        : volumePCR > 2.0
          ? "EXTREME BEARISH FLOW — contrarian buy signal"
          : volumePCR > 1.3
            ? "BEARISH FLOW"
            : "NEUTRAL FLOW";

  const unusualCalls = unusualActivity
    .filter((u) => u.type === "call")
    .sort((a, b) => b.volume - a.volume);
  const unusualPuts = unusualActivity
    .filter((u) => u.type === "put")
    .sort((a, b) => b.volume - a.volume);

  const smartMoneyBias =
    unusualCalls.length > unusualPuts.length * 1.5
      ? "BULLISH"
      : unusualPuts.length > unusualCalls.length * 1.5
        ? "BEARISH"
        : "NEUTRAL";

  const otmCallIV =
    skewData
      .filter(
        (s) =>
          s.type === "call" && s.moneyness > 0.02 && s.moneyness < 0.05
      )
      .reduce((s, v) => s + v.iv, 0) /
    (skewData.filter(
      (s) =>
        s.type === "call" && s.moneyness > 0.02 && s.moneyness < 0.05
    ).length || 1);

  const otmPutIV =
    skewData
      .filter(
        (s) =>
          s.type === "put" && s.moneyness > -0.05 && s.moneyness < -0.02
      )
      .reduce((s, v) => s + v.iv, 0) /
    (skewData.filter(
      (s) =>
        s.type === "put" && s.moneyness > -0.05 && s.moneyness < -0.02
    ).length || 1);

  const skew = otmPutIV - otmCallIV;
  const skewInterpretation =
    skew > 5
      ? "Puts expensive — market fears downside"
      : skew < -3
        ? "Calls expensive — aggressive upside chasing"
        : "Normal skew — balanced fear/greed";

  const maxPainStrike = calculateMaxPain(largeOpenInterest, p);
  const nearestExp = nearExps[0];
  const dteNearest = nearestExp
    ? Math.round(
        (new Date(nearestExp + "T12:00:00") - today) / 86400000
      )
    : null;

  return {
    totalCallVolume,
    totalPutVolume,
    volumePCR: +volumePCR.toFixed(3),
    oiPCR: +oiPCR.toFixed(3),
    flowSentiment,
    smartMoneyBias,
    unusualActivity: unusualActivity
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 5),
    topUnusualCall: unusualCalls[0] || null,
    topUnusualPut: unusualPuts[0] || null,
    largeOILevels: largeOpenInterest
      .sort((a, b) => b.oi - a.oi)
      .slice(0, 8),
    maxPainStrike,
    skew: +skew.toFixed(2),
    skewInterpretation,
    callIV: +otmCallIV.toFixed(1),
    putIV: +otmPutIV.toFixed(1),
    dteNearest,
    flowSummary: buildFlowSummary(
      flowSentiment,
      smartMoneyBias,
      unusualCalls,
      unusualPuts,
      maxPainStrike,
      p,
      skewInterpretation
    ),
  };
}

module.exports = { analyzeOptionsFlow, calculateMaxPain, buildFlowSummary };
