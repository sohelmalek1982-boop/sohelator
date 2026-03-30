/**
 * Liquidity scoring for option legs (scanner alerts).
 * Favor tight spreads + real OI so alerts reference tradeable contracts.
 */

function metrics(opt) {
  const bid = parseFloat(opt.bid || 0);
  const ask = parseFloat(opt.ask || 0);
  let mid = 0;
  if (bid && ask) mid = (bid + ask) / 2;
  else mid = parseFloat(opt.last || opt.mid || 0);
  const spread = ask > bid ? ask - bid : 0;
  const spreadPct = mid > 0 ? spread / mid : 1;
  const oi = parseInt(String(opt.open_interest || opt.openInterest || 0), 10) || 0;
  const vol = parseInt(String(opt.volume || 0), 10) || 0;
  return { bid, ask, mid, spread, spreadPct, oi, vol };
}

function assignTier(m) {
  if (m.mid <= 0 || m.spreadPct > 0.5) return "FAIL";

  const cheap = m.mid < 0.6;
  const sprA = cheap ? 0.11 : 0.08;
  const sprB = cheap ? 0.15 : 0.12;
  const sprC = cheap ? 0.22 : 0.18;

  if (m.spreadPct <= sprA && m.oi >= 600 && (m.vol >= 3 || m.oi >= 1200)) return "A";
  if (m.spreadPct <= sprB && m.oi >= 200) return "B";
  if (m.spreadPct <= sprC && m.oi >= 80) return "C";
  if (m.spreadPct <= 0.28 && m.oi >= 40) return "C";
  return "FAIL";
}

function rankTier(t) {
  return { A: 0, B: 1, C: 2, FAIL: 9 }[t] ?? 9;
}

/**
 * @param {object[]} pool — option rows (same expiry & type)
 * @param {number} underlyingPrice
 * @returns {{ leg: object|null, liquidity: object|null, skipAlert: boolean }}
 */
function pickBestLiquidLeg(pool, underlyingPrice) {
  if (!pool || !pool.length) {
    return { leg: null, liquidity: null, skipAlert: true };
  }

  const enriched = pool.map((o) => {
    const m = metrics(o);
    const tier = assignTier(m);
    return { o, m, tier };
  });

  const viable = enriched.filter((x) => x.tier !== "FAIL");
  const sorted = (viable.length ? viable : enriched).sort((a, b) => {
    const ra = rankTier(a.tier);
    const rb = rankTier(b.tier);
    if (ra !== rb) return ra - rb;
    if (a.m.spreadPct !== b.m.spreadPct) return a.m.spreadPct - b.m.spreadPct;
    return b.m.oi - a.m.oi;
  });

  const best = sorted[0];
  if (!best || best.tier === "FAIL") {
    return {
      leg: null,
      liquidity: best
        ? {
            tier: "FAIL",
            spreadPct: Math.round(best.m.spreadPct * 1000) / 10,
            oi: best.m.oi,
            volume: best.m.vol,
            mid: best.m.mid,
          }
        : null,
      skipAlert: true,
    };
  }

  const liquidity = {
    tier: best.tier,
    spreadPct: Math.round(best.m.spreadPct * 1000) / 10,
    oi: best.m.oi,
    volume: best.m.vol,
    mid: best.m.mid,
  };

  return { leg: best.o, liquidity, skipAlert: false };
}

/**
 * Build candidate strikes near ATM + OTM pick, then choose most liquid.
 */
function buildCandidatePool(pool, strikes, atm, atmLeg, otm) {
  const candidates = [];
  if (atmLeg) candidates.push(atmLeg);
  if (otm) candidates.push(otm);
  const idx = strikes.indexOf(atm);
  if (idx >= 0) {
    [-1, 1, -2, 2].forEach((delta) => {
      const j = idx + delta;
      if (j >= 0 && j < strikes.length) {
        const s = strikes[j];
        const row = pool.find((o) => parseFloat(o.strike) === s);
        if (row) candidates.push(row);
      }
    });
  }
  const seen = new Set();
  return candidates.filter((o) => {
    const k = o.symbol || String(o.strike) + String(o.option_type);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

module.exports = {
  metrics,
  assignTier,
  pickBestLiquidLeg,
  buildCandidatePool,
};
