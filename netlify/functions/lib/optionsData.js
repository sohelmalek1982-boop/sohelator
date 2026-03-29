const { tradierGet } = require("./tradierClient");

function calcLiquidityScore(volume, oi, spread) {
  let score = 0;
  if (volume > 1000) score += 30;
  else if (volume > 500) score += 20;
  else if (volume > 100) score += 10;
  if (oi > 5000) score += 30;
  else if (oi > 1000) score += 20;
  else if (oi > 500) score += 10;
  if (spread < 0.1) score += 40;
  else if (spread < 0.25) score += 25;
  else if (spread < 0.5) score += 10;
  return Math.min(100, score);
}

async function getLiveOptionQuote(optionSymbol) {
  if (!optionSymbol) return null;
  const data = await tradierGet("/v1/markets/quotes", {
    symbols: optionSymbol,
    greeks: "true",
  });
  const raw = data.quotes?.quote;
  const q = Array.isArray(raw) ? raw[0] : raw;
  if (!q) return null;

  const bid = +q.bid || 0;
  const ask = +q.ask || 0;
  const mid = bid && ask ? (bid + ask) / 2 : +q.last || 0;

  const ivRaw = q.greeks?.mid_iv ?? q.greeks?.smv_vol ?? 0;

  return {
    symbol: optionSymbol,
    bid,
    ask,
    mid,
    last: +q.last || 0,
    volume: +q.volume || 0,
    openInterest: +q.open_interest || 0,
    delta: +(q.greeks?.delta || 0),
    gamma: +(q.greeks?.gamma || 0),
    theta: +(q.greeks?.theta || 0),
    vega: +(q.greeks?.vega || 0),
    rho: +(q.greeks?.rho || 0),
    iv: +ivRaw * 100,
    intrinsicValue: 0,
    timeValue: mid,
    spreadPct: ask > 0 ? ((ask - bid) / ask) * 100 : 0,
    spreadWarning: mid > 0 ? (ask - bid) / mid > 0.15 : false,
    liquidityScore: calcLiquidityScore(
      +q.volume || 0,
      +q.open_interest || 0,
      ask - bid
    ),
  };
}

function calcTrailStop(entry, current) {
  if (!entry || entry <= 0) {
    return { level: 0, action: "NO ENTRY", pct: 0 };
  }
  const pnl = ((current - entry) / entry) * 100;
  if (pnl >= 150) {
    return {
      level: entry * 2.0,
      action: "TAKE 75% OFF — hold 25%",
      pct: 100,
    };
  }
  if (pnl >= 100) {
    return { level: entry * 1.7, action: "TRAIL AT +70%", pct: 70 };
  }
  if (pnl >= 80) {
    return {
      level: entry * 1.5,
      action: "TAKE HALF OFF — trail at +50%",
      pct: 50,
    };
  }
  if (pnl >= 60) {
    return { level: entry * 1.3, action: "TRAIL STOP AT +30%", pct: 30 };
  }
  if (pnl >= 40) {
    return { level: entry * 1.0, action: "STOP TO BREAKEVEN", pct: 0 };
  }
  return { level: entry * 0.55, action: "HOLD — stop at -45%", pct: -45 };
}

async function getAlertCurrentPnl(alert) {
  const sym = alert.optionSymbol || alert.option?.occ;
  if (!sym) return null;

  const quote = await getLiveOptionQuote(sym);
  if (!quote) return null;

  const premiumAtAlert =
    alert.premiumAtAlert != null
      ? +alert.premiumAtAlert
      : alert.option?.mid != null
        ? +alert.option.mid
        : 0;

  const realPnlPct =
    premiumAtAlert > 0
      ? ((quote.mid - premiumAtAlert) / premiumAtAlert) * 100
      : 0;

  const ivAtEntry =
    alert.ivAtEntry != null
      ? +alert.ivAtEntry
      : alert.option?.iv != null
        ? parseFloat(String(alert.option.iv).replace(/%/g, ""))
        : null;

  const thetaPerHour = quote.theta / 6.5;
  const hoursToDecay50 =
    Math.abs(thetaPerHour) > 1e-6 ? quote.mid / Math.abs(thetaPerHour) : null;

  return {
    ...quote,
    entryPremium: premiumAtAlert,
    currentPremium: quote.mid,
    realPnlPct,
    realPnlDollar: (quote.mid - premiumAtAlert) * 100,
    trailStop: calcTrailStop(premiumAtAlert || quote.mid, quote.mid),
    thetaWarning:
      quote.mid > 0 && Math.abs(quote.theta) > quote.mid * 0.05,
    thetaPerHour,
    hoursToDecay50,
    ivChange:
      ivAtEntry != null && !Number.isNaN(ivAtEntry)
        ? quote.iv - ivAtEntry
        : null,
    ivCrushWarning:
      ivAtEntry != null &&
      !Number.isNaN(ivAtEntry) &&
      quote.iv < ivAtEntry * 0.8,
  };
}

module.exports = {
  getLiveOptionQuote,
  getAlertCurrentPnl,
  calcTrailStop,
  calcLiquidityScore,
};
