const { tradierGet, normList } = require("./tradierClient");

function findGEXFlip(gexByStrike, _currentPrice) {
  const strikes = Object.keys(gexByStrike)
    .map(Number)
    .sort((a, b) => a - b);
  let cumGEX = 0;
  let prevCum = 0;
  for (const strike of strikes) {
    prevCum = cumGEX;
    cumGEX += gexByStrike[strike];
    if (prevCum * cumGEX < 0) return strike;
  }
  return null;
}

async function calculateGEX(symbol, price) {
  const p = +price || 0;
  if (!p) return null;

  const expData = await tradierGet("/v1/markets/options/expirations", {
    symbol,
    includeAllRoots: "true",
  });
  const exps = expData.expirations?.date;
  const expList = normList(exps).map(String).filter(Boolean);

  const today = new Date();
  const nearExps = expList
    .filter((d) => (new Date(d + "T12:00:00") - today) / 86400000 <= 30)
    .slice(0, 3);

  let totalGEX = 0;
  const gexByStrike = {};

  for (const exp of nearExps) {
    const chainData = await tradierGet("/v1/markets/options/chains", {
      symbol,
      expiration: exp,
      greeks: "true",
    });
    const options = chainData.options?.option;
    if (!options) continue;
    const chain = normList(options);
    const dte =
      (new Date(exp + "T12:00:00") - today) / 86400000;
    const dteWeight = Math.max(0, 1 - dte / 30);

    for (const opt of chain) {
      const gamma = +(opt.greeks?.gamma || 0);
      const oi = +(opt.open_interest || 0);
      const strike = +(opt.strike || 0);
      if (!gamma || !oi || !strike) continue;

      const contractGEX =
        gamma * oi * 100 * p * p * 0.01 * dteWeight;
      const signedGEX =
        opt.option_type === "call" ? contractGEX : -contractGEX;
      totalGEX += signedGEX;
      if (!gexByStrike[strike]) gexByStrike[strike] = 0;
      gexByStrike[strike] += signedGEX;
    }
  }

  const sortedStrikes = Object.entries(gexByStrike)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .slice(0, 10);

  const keyGEXLevels = sortedStrikes.map(([strike, gex]) => ({
    strike: +strike,
    gex,
    type: gex > 0 ? "resistance" : "support",
    strength:
      Math.abs(gex) > Math.abs(totalGEX) * 0.1 ? "major" : "minor",
    distancePct: (((+strike - p) / p) * 100).toFixed(2),
  }));

  const gexResistance = keyGEXLevels
    .filter((l) => l.type === "resistance" && +l.strike > p)
    .sort((a, b) => +a.strike - +b.strike)[0];

  const gexSupport = keyGEXLevels
    .filter((l) => l.type === "support" && +l.strike < p)
    .sort((a, b) => +b.strike - +a.strike)[0];

  const gexRegime = totalGEX > 0 ? "POSITIVE" : "NEGATIVE";
  const interpretation =
    totalGEX > 1e9
      ? "Very high positive GEX — price likely pinned. Low volatility expected. Difficult day for momentum plays."
      : totalGEX > 0
        ? "Positive GEX — market makers selling volatility. Price tends to revert. Good for mean reversion."
        : totalGEX > -1e9
          ? "Slightly negative GEX — some directional moves possible. Moderate volatility."
          : "High negative GEX — EXPLOSIVE moves likely. Market makers must chase price. Big trends possible today.";

  const gexFlipLevel = findGEXFlip(gexByStrike, p);

  return {
    totalGEX,
    gexRegime,
    gexByStrike,
    keyGEXLevels: keyGEXLevels.slice(0, 5),
    gexResistance,
    gexSupport,
    gexFlipLevel,
    interpretation,
    tradingImplication: {
      expectedVolatility:
        gexRegime === "POSITIVE"
          ? "LOW — expect chop"
          : "HIGH — expect big moves",
      bestStrategy:
        gexRegime === "POSITIVE"
          ? "Sell premium (spreads) — price will pin"
          : "Buy premium (outrights) — big moves coming",
      warningAbove: gexResistance?.strike,
      supportBelow: gexSupport?.strike,
      flipLevel: gexFlipLevel,
      flipWarning:
        gexFlipLevel && Math.abs(p - gexFlipLevel) / p < 0.02
          ? `Price within 2% of GEX flip level at $${gexFlipLevel}. Crossing this could trigger explosive move.`
          : null,
    },
  };
}

module.exports = { calculateGEX, findGEXFlip };
