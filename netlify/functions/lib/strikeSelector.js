function buildStrikeReasoning(strike, price, direction, score, expectedMove, levels) {
  const lines = [];
  const type = direction === "bull" ? "call" : "put";
  lines.push(
    `Recommended: $${strike.strike} ${type} @ $${(strike.mid ?? 0).toFixed(2)} (delta: ${(strike.delta ?? 0).toFixed(2)})`
  );
  lines.push(
    `Expected move: $${expectedMove.toFixed(2)} — strike is ${Math.abs(strike.strike - price).toFixed(2)} away`
  );
  if (levels?.nearestResistance && direction === "bull") {
    lines.push(
      `Next resistance: $${levels.nearestResistance.price?.toFixed(2)} (${levels.nearestResistance.label})`
    );
  }
  lines.push(
    `OI: ${(strike.oi ?? 0).toLocaleString()} | Spread: ${((strike.spreadPct ?? 0) * 100).toFixed(1)}%`
  );
  return lines.join("\n");
}

async function selectOptimalStrike(
  symbol,
  direction,
  price,
  chain,
  momentum,
  levels,
  score,
  regime,
  daysHolding
) {
  void symbol;
  if (!chain?.length) return null;

  const p = +price || 0;
  const atr = momentum?.atr || p * 0.02;
  const expectedMove = atr * (daysHolding || 2);

  const options = chain
    .filter((o) => o.option_type === (direction === "bull" ? "call" : "put"))
    .filter((o) => {
      const bid = +o.bid || 0;
      const ask = +o.ask || 0;
      const mid = bid && ask ? (bid + ask) / 2 : +o.last || 0;
      return mid > 0.1 && mid < p * 0.15;
    });

  if (!options.length) return null;

  const scoredStrikes = options.map((opt) => {
    const strike = +opt.strike;
    const bid = +opt.bid || 0;
    const ask = +opt.ask || 0;
    const mid = bid && ask ? (bid + ask) / 2 : +opt.last || 0;
    const delta = +(opt.greeks?.delta || 0);
    const iv = +(opt.greeks?.mid_iv || 0) * 100;
    const gamma = +(opt.greeks?.gamma || 0);
    const theta = +(opt.greeks?.theta || 0);
    const oi = +(opt.open_interest || 0);
    const vol = +(opt.volume || 0);
    const spread = ask - bid;
    const spreadPct = mid > 0 ? spread / mid : 1;

    let strikeScore = 0;
    const absDelta = Math.abs(delta);
    if (direction === "bull") {
      if (score >= 90) {
        if (absDelta >= 0.3 && absDelta <= 0.4) strikeScore += 30;
        else if (absDelta >= 0.25 && absDelta <= 0.45) strikeScore += 20;
      } else {
        if (absDelta >= 0.45 && absDelta <= 0.55) strikeScore += 30;
        else if (absDelta >= 0.4 && absDelta <= 0.6) strikeScore += 20;
      }
    } else {
      if (absDelta >= 0.35 && absDelta <= 0.55) strikeScore += 25;
    }

    if (direction === "bull") {
      const distFromExpected = Math.abs(strike - (p + expectedMove * 0.8));
      if (distFromExpected < atr * 0.5) strikeScore += 25;
      else if (distFromExpected < atr) strikeScore += 15;
    }

    if (direction === "bull" && levels?.nearestResistance) {
      const distToRes = Math.abs(strike - levels.nearestResistance.price);
      if (distToRes < p * 0.01) strikeScore -= 20;
      else if (distToRes > p * 0.02) strikeScore += 10;
    }

    if (oi > 5000) strikeScore += 15;
    else if (oi > 1000) strikeScore += 8;
    else if (oi < 100) strikeScore -= 15;

    if (spreadPct < 0.1) strikeScore += 10;
    else if (spreadPct > 0.25) strikeScore -= 15;

    if (regime?.thresholds?.preferredStrategy === "spread") {
      if (absDelta >= 0.45) strikeScore += 10;
    }

    const tgRatio =
      gamma > 0 && Math.abs(theta) > 0 ? gamma / Math.abs(theta) : 0;
    if (tgRatio > 0.5) strikeScore += 10;

    const expRet =
      direction === "bull"
        ? mid > 0
          ? (((p + expectedMove - strike) / mid) * 100).toFixed(0) + "%"
          : "—"
        : mid > 0
          ? (((strike - p + expectedMove) / mid) * 100).toFixed(0) + "%"
          : "—";

    return {
      strike,
      mid,
      delta: absDelta,
      iv,
      gamma,
      theta,
      oi,
      vol,
      spreadPct,
      strikeScore,
      symbol: opt.symbol,
      expiry: opt.expiration_date || opt.expiration,
      recommendation: "",
      expectedReturn: expRet,
    };
  });

  scoredStrikes.sort((a, b) => b.strikeScore - a.strikeScore);
  const best = scoredStrikes[0];
  const alternative = scoredStrikes[1];
  if (!best) return null;

  best.recommendation =
    "PRIMARY — best balance of delta (" +
    best.delta.toFixed(2) +
    "), liquidity (OI: " +
    best.oi +
    "), and expected move alignment";
  if (alternative) {
    alternative.recommendation =
      score >= 88
        ? "AGGRESSIVE — higher leverage for strong conviction plays"
        : "CONSERVATIVE — higher probability";
  }

  return {
    primary: best,
    alternative: alternative || null,
    reasoning: buildStrikeReasoning(
      best,
      p,
      direction,
      score,
      expectedMove,
      levels
    ),
  };
}

module.exports = { selectOptimalStrike, buildStrikeReasoning };
