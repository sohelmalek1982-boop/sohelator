import { getTimesales, getDailyHistory, getQuote } from "../../src/lib/tradier.js";
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  /** Avoid stale matrix / regime in browser or intermediate caches */
  "Cache-Control": "private, no-store, must-revalidate",
};

function ymdEt() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  let ema = prices[0];
  const result = [ema];
  for (let i = 1; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function getETHour() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}

function isWeekday() {
  const d = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(new Date());
  return d !== "Sat" && d !== "Sun";
}

/** Bull/bear % from EMA velocity alignment + regime tilt (normalized to ~100%). */
function calculateMarketProbability(cur, gradClass, macroRegime) {
  const vels = [
    cur.ema4_vel,
    cur.ema9_vel,
    cur.ema14_vel,
    cur.ema21_vel,
    cur.ema50_vel,
    cur.ema100_vel,
  ];
  let bullW = 0;
  let bearW = 0;
  for (const v of vels) {
    if (v > 0.05) bullW += 1.25;
    else if (v > 0) bullW += 0.75;
    else if (v < -0.05) bearW += 1.25;
    else if (v < 0) bearW += 0.75;
    else {
      bullW += 0.25;
      bearW += 0.25;
    }
  }
  if (gradClass === "BULL_GRAD") bullW += 0.75;
  if (gradClass === "BEAR_GRAD") bearW += 0.75;
  if (macroRegime === "BULL_REGIME") bullW += 1;
  if (macroRegime === "BEAR_REGIME") bearW += 1;
  const t = bullW + bearW || 1;
  let bullPct = Math.round((bullW / t) * 100);
  let bearPct = 100 - bullPct;

  if (macroRegime === "TRANSITION") {
    if (bullPct >= bearPct) {
      bullPct = Math.min(65, bullPct);
      bearPct = 100 - bullPct;
    } else {
      bearPct = Math.min(65, bearPct);
      bullPct = 100 - bearPct;
    }
  }

  return { bullPct, bearPct };
}

function generateMarketNarrative(bullPct, bearPct, avgVel, gradClass, gradTier, _macroRegime, prevBias) {
  const isStrongBull = bullPct >= 75;
  const isMildBull = bullPct >= 60 && bullPct < 75;
  const isStrongBear = bearPct >= 75;
  const isMildBear = bearPct >= 60 && bearPct < 75;

  const wasbull = prevBias && (prevBias.includes("BULL") || prevBias.includes("bull"));
  const wasbear = prevBias && (prevBias.includes("BEAR") || prevBias.includes("bear"));
  const velocitySlowing = avgVel > 0 && avgVel < 0.03;
  const velocityAccel = Math.abs(avgVel) > 0.1;

  let narrative = "";
  let emoji = "";
  let sendAlert = false;
  let urgency = "low";

  if (isStrongBull) {
    emoji = "🟢";
    if (velocityAccel) {
      narrative = `Bulls in full control — only longs. Momentum accelerating, ${bullPct}% probability market continues higher. Ride it.`;
    } else {
      narrative = `Bulls in control — favor longs. ${bullPct}% bullish probability. EMA stack aligned, macro regime supports upside.`;
    }
    sendAlert = !prevBias || prevBias !== "STRONGLY_BULLISH";
    urgency = "high";
  } else if (isMildBull) {
    emoji = "🟡";
    if (velocitySlowing && wasbull) {
      narrative = `Bulls losing steam — ${bullPct}% probability but momentum fading. Consider tightening stops on longs, reversal probability increasing toward 40%.`;
      sendAlert = true;
      urgency = "high";
    } else if (wasbear) {
      narrative = `Shift detected — bulls gaining control at ${bullPct}%. Bears losing grip. Watch for continuation above key levels.`;
      sendAlert = true;
      urgency = "high";
    } else {
      narrative = `Mild bullish lean — ${bullPct}% probability. Not full conviction yet. Wait for stronger signal before sizing up.`;
      sendAlert = false;
      urgency = "low";
    }
  } else if (isStrongBear) {
    emoji = "🔴";
    if (velocityAccel) {
      narrative = `Bears in full control — only shorts. Selling accelerating, ${bearPct}% probability market continues lower. Avoid longs.`;
    } else {
      narrative = `Bears in control — favor shorts. ${bearPct}% bearish probability. EMA stack inverted, downside momentum intact.`;
    }
    sendAlert = !prevBias || prevBias !== "STRONGLY_BEARISH";
    urgency = "high";
  } else if (isMildBear) {
    emoji = "🟠";
    if (velocitySlowing && wasbear) {
      narrative = `Bears losing steam — ${bearPct}% probability but selling slowing. Reversal probability climbing above 40%. Cover shorts, watch for bounce.`;
      sendAlert = true;
      urgency = "high";
    } else if (wasbull) {
      narrative = `Shift detected — bears gaining control at ${bearPct}%. Bulls losing grip. Be cautious on new longs.`;
      sendAlert = true;
      urgency = "high";
    } else {
      narrative = `Mild bearish lean — ${bearPct}% probability. Not full conviction. Reduce exposure, wait for clarity.`;
      sendAlert = false;
      urgency = "low";
    }
  } else {
    emoji = "⚪";
    if (wasbull || wasbear) {
      narrative = `Market losing direction — bulls and bears balanced. Previous trend exhausting. Cash is a position. Wait for breakout.`;
      sendAlert = true;
      urgency = "medium";
    } else {
      narrative = `Market neutral — no clear edge. ${bullPct}% bull / ${bearPct}% bear. Stay flat until direction emerges.`;
      sendAlert = false;
      urgency = "low";
    }
  }

  if (gradTier === "golden" && gradClass === "BULL_GRAD") {
    narrative += ` Golden graduation active — highest conviction long setup.`;
  } else if (gradTier === "golden" && gradClass === "BEAR_GRAD") {
    narrative += ` Golden graduation active — highest conviction short setup.`;
  } else if (gradTier === "elite") {
    narrative += ` Elite tier graduation — strong signal.`;
  }

  const biasKey = isStrongBull
    ? "STRONGLY_BULLISH"
    : isMildBull
      ? "MILDLY_BULLISH"
      : isStrongBear
        ? "STRONGLY_BEARISH"
        : isMildBear
          ? "MILDLY_BEARISH"
          : "NEUTRAL";

  return { narrative, emoji, sendAlert, urgency, biasKey };
}

function normList(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

/**
 * Approximate GEX from Tradier chain (gamma × OI × 100 × spot). Not vendor GEX — for levels only.
 */
async function calculateGEXLevels(currentPrice) {
  try {
    const token = process.env.TRADIER_TOKEN;
    if (!token) return null;

    const tradierBase =
      (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
        ? "https://sandbox.tradier.com"
        : "https://api.tradier.com";

    const expRes = await fetch(
      `${tradierBase}/v1/markets/options/expirations?symbol=SPY&includeAllRoots=false`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      }
    );
    const expData = await expRes.json();
    const expirations = expData?.expirations?.date;
    const expList = normList(expirations).map(String).filter(Boolean);
    if (!expList.length) return null;

    const nearExp = expList[0];

    const chainRes = await fetch(
      `${tradierBase}/v1/markets/options/chains?symbol=SPY&expiration=${encodeURIComponent(
        nearExp
      )}&greeks=true`,
      { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } }
    );
    const chainData = await chainRes.json();
    const options = normList(chainData?.options?.option);
    if (!options.length) return null;

    const gexByStrike = {};
    const minStrike = currentPrice * 0.95;
    const maxStrike = currentPrice * 1.05;

    for (const o of options) {
      const strike = parseFloat(o.strike);
      if (!Number.isFinite(strike) || strike < minStrike || strike > maxStrike) continue;
      const gamma = parseFloat(o.greeks?.gamma || 0);
      const oi = parseFloat(o.open_interest || 0);
      const ot = String(o.option_type || "").toLowerCase();
      const gexMag = gamma * oi * 100 * currentPrice;
      let signed = 0;
      if (ot === "call") signed = gexMag;
      else if (ot === "put") signed = -gexMag;
      else continue;
      gexByStrike[strike] = (gexByStrike[strike] || 0) + signed;
    }

    const strikes = Object.keys(gexByStrike)
      .map(Number)
      .sort((a, b) => a - b);
    if (!strikes.length) return null;

    let cumGex = 0;
    let zeroGammaLevel = null;
    for (const strike of strikes) {
      const prevCum = cumGex;
      cumGex += gexByStrike[strike];
      if (
        zeroGammaLevel == null &&
        prevCum !== 0 &&
        cumGex !== 0 &&
        prevCum * cumGex < 0
      ) {
        zeroGammaLevel = strike;
      }
    }

    const posStrikes = strikes.filter((s) => gexByStrike[s] > 0);
    const negStrikes = strikes.filter((s) => gexByStrike[s] < 0);
    const maxPosStrike =
      posStrikes.length > 0
        ? posStrikes.reduce((best, s) =>
            gexByStrike[s] > gexByStrike[best] ? s : best
          )
        : null;
    const maxNegStrike =
      negStrikes.length > 0
        ? negStrikes.reduce((best, s) =>
            gexByStrike[s] < gexByStrike[best] ? s : best
          )
        : null;

    const keyLevels = [];

    if (maxPosStrike != null) {
      keyLevels.push({
        price: maxPosStrike,
        type: "CALL_WALL",
        label: "Call wall (resistance)",
        gex: Math.round(gexByStrike[maxPosStrike] / 1_000_000),
        side: "resistance",
      });
    }

    if (maxNegStrike != null && maxNegStrike !== maxPosStrike) {
      keyLevels.push({
        price: maxNegStrike,
        type: "PUT_WALL",
        label: "Put wall (support)",
        gex: Math.round(Math.abs(gexByStrike[maxNegStrike]) / 1_000_000),
        side: "support",
      });
    }

    if (zeroGammaLevel != null) {
      keyLevels.push({
        price: zeroGammaLevel,
        type: "ZERO_GAMMA",
        label: "Zero gamma level",
        gex: 0,
        side: "pivot",
      });
    }

    keyLevels.sort(
      (a, b) =>
        Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice)
    );

    return {
      expiration: nearExp,
      keyLevels,
      zeroGammaLevel,
      callWall: maxPosStrike,
      putWall: maxNegStrike,
      totalGEX: Math.round(cumGex / 1_000_000),
    };
  } catch (e) {
    console.warn("GEX calculation error:", e?.message || e);
    return null;
  }
}

/**
 * Where spot sits vs GEX walls / zero-gamma; rejection & confirmation on 15m bars (bars15).
 */
function analyzeGEXContext(currentPrice, gexData, bars15) {
  if (!gexData || !gexData.keyLevels?.length) return null;

  const alerts = [];
  const levelAnalysis = [];

  for (const level of gexData.keyLevels) {
    const distPct = ((currentPrice - level.price) / level.price) * 100;
    const absPct = Math.abs(distPct);
    const direction = distPct > 0 ? "above" : "below";
    const approaching = absPct < 0.8;
    const atLevel = absPct < 0.3;

    let rejectionDetected = false;
    let rejectionDirection = null;
    if (bars15 && bars15.length >= 3 && atLevel) {
      const last3 = bars15.slice(-3);
      const closes = last3.map((b) => parseFloat(b.close));
      const highs = last3.map((b) => parseFloat(b.high));
      const lows = last3.map((b) => parseFloat(b.low));

      if (level.side === "resistance") {
        const touchedLevel = highs.some((h) => h >= level.price * 0.999);
        const closedBelow = closes[closes.length - 1] < level.price;
        if (touchedLevel && closedBelow) {
          rejectionDetected = true;
          rejectionDirection = "short";
        }
      }

      if (level.side === "support") {
        const touchedLevel = lows.some((l) => l <= level.price * 1.001);
        const closedAbove = closes[closes.length - 1] > level.price;
        if (touchedLevel && closedAbove) {
          rejectionDetected = true;
          rejectionDirection = "long";
        }
      }
    }

    let confirmationDetected = false;
    let confirmationDirection = null;
    if (bars15 && bars15.length >= 2) {
      const lastClose = parseFloat(bars15[bars15.length - 1].close);
      const prevClose = parseFloat(bars15[bars15.length - 2].close);

      if (level.side === "resistance" && lastClose > level.price && prevClose <= level.price) {
        confirmationDetected = true;
        confirmationDirection = "long";
      }

      if (level.side === "support" && lastClose < level.price && prevClose >= level.price) {
        confirmationDetected = true;
        confirmationDirection = "short";
      }
    }

    const reversalProb =
      level.type === "CALL_WALL"
        ? 67
        : level.type === "PUT_WALL"
          ? 63
          : level.type === "ZERO_GAMMA"
            ? 55
            : 50;

    const baseWinRate = 54;
    const confirmedWinRate = 67;

    const analysis = {
      level: level.price,
      type: level.type,
      label: level.label,
      side: level.side,
      distPct: Math.round(distPct * 100) / 100,
      absPct: Math.round(absPct * 100) / 100,
      direction,
      approaching,
      atLevel,
      rejectionDetected,
      rejectionDirection,
      confirmationDetected,
      confirmationDirection,
      reversalProb,
      baseWinRate,
      confirmedWinRate,
    };

    levelAnalysis.push(analysis);

    if (confirmationDetected) {
      alerts.push({
        type: "CONFIRMATION",
        urgency: "HIGH",
        direction: confirmationDirection,
        level: level.price,
        absPct: Math.round(absPct * 100) / 100,
        levelLabel: level.label,
        message:
          confirmationDirection === "long"
            ? `✅ CONFIRMED ENTRY — SPY closed ABOVE ${level.label} at $${level.price}\nBreakout confirmed — go LONG now\nWin rate jumps from ${baseWinRate}% → ${confirmedWinRate}% with confirmation\nEntry: market open | Stop: $${(level.price * 0.99).toFixed(2)} | Target: $${(level.price * 1.02).toFixed(2)}`
            : `✅ CONFIRMED ENTRY — SPY closed BELOW ${level.label} at $${level.price}\nBreakdown confirmed — go SHORT now\nWin rate jumps from ${baseWinRate}% → ${confirmedWinRate}% with confirmation\nEntry: market | Stop: $${(level.price * 1.01).toFixed(2)} | Target: $${(level.price * 0.98).toFixed(2)}`,
      });
    } else if (rejectionDetected) {
      alerts.push({
        type: "REJECTION",
        urgency: "HIGH",
        direction: rejectionDirection,
        level: level.price,
        absPct: Math.round(absPct * 100) / 100,
        levelLabel: level.label,
        message:
          rejectionDirection === "short"
            ? `🔴 GEX REJECTION — SPY rejected at ${level.label} $${level.price}\nPrice closed below on 15m — consider SHORT entry\nReversal probability: ${reversalProb}%\nEntry: current | Stop: $${(level.price * 1.005).toFixed(2)} above level | Target: $${(currentPrice * 0.99).toFixed(2)}`
            : `🟢 GEX BOUNCE — SPY bounced off ${level.label} $${level.price}\nPrice closed above on 15m — consider LONG entry\nReversal probability: ${reversalProb}%\nEntry: current | Stop: $${(level.price * 0.995).toFixed(2)} below level | Target: $${(currentPrice * 1.01).toFixed(2)}`,
      });
    } else if (approaching && absPct < 0.5) {
      alerts.push({
        type: "APPROACHING",
        urgency: "MEDIUM",
        direction: level.side === "resistance" ? "watch_short" : "watch_long",
        level: level.price,
        absPct: Math.round(absPct * 100) / 100,
        levelLabel: level.label,
        message:
          level.side === "resistance"
            ? `⚠️ SPY approaching ${level.label} at $${level.price}\n${absPct.toFixed(2)}% away — expect potential reversal here\nReversal probability: ${reversalProb}%\nWait for rejection confirmation before shorting\nConfirmed entry win rate: ${confirmedWinRate}% vs unconfirmed: ${baseWinRate}%`
            : `⚠️ SPY approaching ${level.label} at $${level.price}\n${absPct.toFixed(2)}% away — watch for bounce\nReversal probability: ${reversalProb}%\nWait for bounce confirmation before going long\nConfirmed entry win rate: ${confirmedWinRate}% vs unconfirmed: ${baseWinRate}%`,
      });
    } else if (approaching) {
      alerts.push({
        type: "NEAR_LEVEL",
        urgency: "LOW",
        direction: null,
        level: level.price,
        absPct: Math.round(absPct * 100) / 100,
        levelLabel: level.label,
        message: `📍 SPY is ${absPct.toFixed(2)}% away from ${level.label} at $${level.price}\nExpect ${level.side === "resistance" ? "resistance" : "support"} reaction — reversal probability ${reversalProb}%`,
      });
    }
  }

  return { levelAnalysis, alerts };
}

/** Price within ~0.15% of a GEX key level — confirmation-style entry cue; Telegram deduped per level per ET day. */
async function maybeSendGEXConfirmationTelegram(
  spyPrice,
  gex,
  positionStore,
  ctx
) {
  if (!gex?.keyLevels?.length || !positionStore) return;
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;

  const threshold = spyPrice * 0.0015;
  const nearby = gex.keyLevels
    .map((L) => ({ ...L, dist: Math.abs(spyPrice - L.price) }))
    .filter((x) => x.dist <= threshold)
    .sort((a, b) => a.dist - b.dist);
  if (!nearby.length) return;

  const L = nearby[0];
  const fp = `${L.type}|${Math.round(L.price * 100) / 100}`;
  const ymd = ymdEt();
  try {
    const prev = await positionStore.get("gex-confirm-dedupe", { type: "json" });
    if (prev && prev.ymd === ymd && prev.fp === fp) return;
  } catch (e) {
    console.warn("gex-confirm-dedupe read", e?.message || e);
  }

  const msg = [
    `📍 GEX CONFIRMATION — SPY $${spyPrice.toFixed(2)}`,
    `Near ${L.label} @ $${L.price.toFixed(2)} (${L.type})`,
    `Matrix: ${ctx.gradClass} ${ctx.gradTier} | ${ctx.macroRegime}`,
    ``,
    `Walls: call ${gex.callWall ?? "—"} | put ${gex.putWall ?? "—"} | zero γ ${gex.zeroGammaLevel ?? "—"}`,
    `Expiry: ${gex.expiration} | total GEX ~${gex.totalGEX}M (approx)`,
  ].join("\n");

  try {
    const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
    });
    if (!r.ok) return;
    await positionStore.setJSON("gex-confirm-dedupe", {
      ymd,
      fp,
      at: Date.now(),
    });
  } catch (e) {
    console.warn("GEX confirmation Telegram", e?.message || e);
  }
}

export const handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  if (!process.env.TRADIER_TOKEN) {
    return { statusCode: 200, headers, body: JSON.stringify({ error: "no_token", progressPct: 0 }) };
  }

  try {
    const bars15 = await getTimesales("SPY", "15min", 7);
    if (!bars15 || bars15.length < 20) {
      return { statusCode: 200, headers, body: JSON.stringify({ error: "insufficient_bars", progressPct: 0 }) };
    }

    let currentPrice = parseFloat(bars15[bars15.length - 1].close);
    try {
      const freshQuote = await getQuote("SPY");
      const q = parseFloat(
        freshQuote?.last ?? freshQuote?.bid ?? freshQuote?.ask ?? ""
      );
      if (Number.isFinite(q) && q > 0) {
        currentPrice = q;
      }
    } catch (e) {
      console.warn("matrix-signal getQuote", e?.message || e);
    }

    // Calculate GEX levels
    let gexData = null;
    try {
      gexData = await calculateGEXLevels(currentPrice);
    } catch (e) {
      console.warn("matrix-signal calculateGEXLevels", e?.message || e);
    }
    let gexContext = null;
    try {
      gexContext = gexData ? analyzeGEXContext(currentPrice, gexData, bars15) : null;
    } catch (e) {
      console.warn("matrix-signal analyzeGEXContext", e?.message || e);
    }

    const closes = bars15.map((b) => parseFloat(b.close));

    const periods = [4, 9, 14, 21, 50, 100];
    const dists = {};
    const vels = {};

    for (const p of periods) {
      if (closes.length < p) continue;
      const emaVals = calculateEMA(closes, p);
      dists[p] = closes.map((c, i) => ((c - emaVals[i]) / emaVals[i]) * 100);
      vels[p] = dists[p].map((d, i) => (i === 0 ? 0 : d - dists[p][i - 1]));
    }

    const lastIdx = closes.length - 1;

    const cur = {
      ema4_dist: dists[4]?.[lastIdx] || 0,
      ema9_dist: dists[9]?.[lastIdx] || 0,
      ema14_dist: dists[14]?.[lastIdx] || 0,
      ema21_dist: dists[21]?.[lastIdx] || 0,
      ema50_dist: dists[50]?.[lastIdx] || 0,
      ema100_dist: dists[100]?.[lastIdx] || 0,
      ema4_vel: vels[4]?.[lastIdx] || 0,
      ema9_vel: vels[9]?.[lastIdx] || 0,
      ema14_vel: vels[14]?.[lastIdx] || 0,
      ema21_vel: vels[21]?.[lastIdx] || 0,
      ema50_vel: vels[50]?.[lastIdx] || 0,
      ema100_vel: vels[100]?.[lastIdx] || 0,
    };

    const avgVel =
      (cur.ema4_vel +
        cur.ema9_vel +
        cur.ema14_vel +
        cur.ema21_vel +
        cur.ema50_vel +
        cur.ema100_vel) /
      6;
    const gradClass =
      avgVel > 0.05 ? "BULL_GRAD" : avgVel < -0.05 ? "BEAR_GRAD" : "MIXED";

    const strength =
      Math.abs(cur.ema4_vel) +
      Math.abs(cur.ema9_vel) +
      Math.abs(cur.ema14_vel) +
      Math.abs(cur.ema21_vel) +
      Math.abs(cur.ema50_vel) +
      Math.abs(cur.ema100_vel);
    const tier =
      strength > 7.0
        ? "golden"
        : strength > 4.5
          ? "elite"
          : strength > 2.5
            ? "strong"
            : strength > 1.0
              ? "moderate"
              : "weak";

    const r_4_9 = cur.ema9_dist !== 0 ? cur.ema4_dist / cur.ema9_dist : 0;
    const rv_4_9 = cur.ema9_vel !== 0 ? cur.ema4_vel / cur.ema9_vel : 0;
    const rv_9_21 = cur.ema21_vel !== 0 ? cur.ema9_vel / cur.ema21_vel : 0;
    const ratiosPass =
      r_4_9 >= 0.5 && r_4_9 <= 2.0 && rv_4_9 >= 0.8 && rv_9_21 >= 0.7;

    const daily = await getDailyHistory("SPY", 60);
    let macroRegime = "TRANSITION";
    if (daily && daily.length >= 100) {
      const dc = daily.map((b) => parseFloat(b.close));
      const weeklyEMA21 = calculateEMA(dc, 21);
      const weeklyEMA50 = calculateEMA(dc, 50);
      const weeklyEMA100 = calculateEMA(dc, 100);
      const li = dc.length - 1;
      if (weeklyEMA21[li] > weeklyEMA50[li] && weeklyEMA50[li] > weeklyEMA100[li]) {
        macroRegime = "BULL_REGIME";
      } else if (weeklyEMA21[li] < weeklyEMA50[li] && weeklyEMA50[li] < weeklyEMA100[li]) {
        macroRegime = "BEAR_REGIME";
      }
    }

    const etMin = getETHour();
    const sessionValid = isWeekday() && etMin >= 600 && etMin <= 900;

    const primarySignal =
      gradClass === "BULL_GRAD" &&
      ["strong", "elite", "golden"].includes(tier) &&
      macroRegime === "BULL_REGIME" &&
      sessionValid &&
      ratiosPass;

    const secondarySignal =
      !primarySignal &&
      gradClass === "BULL_GRAD" &&
      ["strong", "elite", "golden"].includes(tier) &&
      macroRegime === "BULL_REGIME" &&
      sessionValid;

    const tierScore =
      tier === "golden" ? 30 : tier === "elite" ? 20 : tier === "strong" ? 10 : 5;
    const gradScore = gradClass !== "MIXED" ? 40 : 10;
    const sigScore = primarySignal ? 30 : secondarySignal ? 15 : 0;
    const progressPct = Math.min(100, gradScore + tierScore + sigScore);

    const marketProb = calculateMarketProbability(cur, gradClass, macroRegime);

    let positionStore = null;
    if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) {
      positionStore = getStore({
        name: "sohelator-positions",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_TOKEN,
      });
    }
    const prevBiasData = positionStore
      ? await positionStore.get("market-prob-last-bias", { type: "json" }).catch(() => null)
      : null;
    const prevBias = prevBiasData?.biasKey || null;

    await maybeSendGEXConfirmationTelegram(currentPrice, gexData, positionStore, {
      gradClass,
      gradTier: tier,
      macroRegime,
    });

    const nar = generateMarketNarrative(
      marketProb.bullPct,
      marketProb.bearPct,
      avgVel,
      gradClass,
      tier,
      macroRegime,
      prevBias
    );
    if (macroRegime === "TRANSITION") {
      nar.sendAlert = false;
    }

    const signal = {
      timestamp: new Date().toISOString(),
      gradClass,
      gradTier: tier,
      gradStrength: Math.round(strength * 100) / 100,
      primarySignal,
      secondarySignal,
      macroRegime,
      sessionValid,
      ratiosPass,
      marketProb,
      narrative: {
        text: nar.narrative,
        emoji: nar.emoji,
        biasKey: nar.biasKey,
        urgency: nar.urgency,
      },
      ratios: {
        r_4_9: Math.round(r_4_9 * 100) / 100,
        rv_4_9: Math.round(rv_4_9 * 100) / 100,
        rv_9_21: Math.round(rv_9_21 * 100) / 100,
      },
      ema_distances: {
        ema4: Math.round(cur.ema4_dist * 100) / 100,
        ema9: Math.round(cur.ema9_dist * 100) / 100,
        ema21: Math.round(cur.ema21_dist * 100) / 100,
        ema50: Math.round(cur.ema50_dist * 100) / 100,
        ema100: Math.round(cur.ema100_dist * 100) / 100,
      },
      ema_velocities: {
        ema4: Math.round(cur.ema4_vel * 1000) / 1000,
        ema9: Math.round(cur.ema9_vel * 1000) / 1000,
        ema21: Math.round(cur.ema21_vel * 1000) / 1000,
        ema50: Math.round(cur.ema50_vel * 1000) / 1000,
        ema100: Math.round(cur.ema100_vel * 1000) / 1000,
      },
      progressPct,
      spyPrice: Math.round(currentPrice * 100) / 100,
      currentPrice,
      gex: gexData
        ? {
            callWall: gexData.callWall,
            putWall: gexData.putWall,
            zeroGammaLevel: gexData.zeroGammaLevel,
            expiration: gexData.expiration,
            keyLevels: gexData.keyLevels.slice(0, 3),
            totalGEX: gexData.totalGEX,
          }
        : null,
      gexAlerts: gexContext?.alerts || [],
      gexLevels: gexContext?.levelAnalysis || [],
      recommendation: primarySignal
        ? "PRIMARY SIGNAL — enter ATM call spread 7-10 DTE"
        : secondarySignal
          ? "SECONDARY SIGNAL — monitor for confirmation"
          : `Building: ${gradClass} ${tier} tier`,
    };

    // Send GEX alerts — each one independently
    if (gexContext?.alerts?.length && positionStore) {
      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_CHAT_ID;
      if (bot && chat) {
        const gexSentKey = "gex-alerts-sent";
        let gexSent =
          (await positionStore.get(gexSentKey, { type: "json" }).catch(() => null)) || {};
        if (typeof gexSent !== "object" || gexSent === null) gexSent = {};

        function gexAlertCooldownMs(type) {
          switch (type) {
            case "CONFIRMATION":
              return 6 * 60 * 60 * 1000;
            case "REJECTION":
              return 3 * 60 * 60 * 1000;
            case "APPROACHING":
              return 60 * 60 * 1000;
            case "NEAR_LEVEL":
              return 4 * 60 * 60 * 1000;
            default:
              return 4 * 60 * 60 * 1000;
          }
        }

        for (const alert of gexContext.alerts) {
          const absPct = Number(alert.absPct);
          const distBucket = Number.isFinite(absPct)
            ? Math.round(absPct * 10)
            : 0;
          const dedupeKey = `${alert.type}-${alert.level}-${distBucket}`;
          const cooldown = gexAlertCooldownMs(alert.type);
          const lastSent = gexSent[dedupeKey] || 0;

          if (Date.now() - lastSent < cooldown) continue;

          await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chat,
              text: alert.message,
              disable_web_page_preview: true,
            }),
          }).catch(() => {});

          gexSent[dedupeKey] = Date.now();
          await new Promise((r) => setTimeout(r, 300));
        }

        await positionStore.setJSON(gexSentKey, gexSent).catch(() => {});
      }
    }

    const narrativeBiasChanged =
      !prevBiasData ||
      prevBiasData.biasKey !== nar.biasKey ||
      Math.abs((prevBiasData.bullPct || 0) - marketProb.bullPct) >= 15;

    if (nar.sendAlert && narrativeBiasChanged) {
      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_CHAT_ID;
      if (bot && chat) {
        const msg = [
          `${nar.emoji} SOHELATOR MARKET CONTEXT`,
          ``,
          nar.narrative,
          ``,
          `Bull: ${marketProb.bullPct}% | Bear: ${marketProb.bearPct}%`,
          `Regime: ${macroRegime} | ${gradClass} ${tier}`,
          new Date().toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
          }) + " ET",
        ].join("\n");
        fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
        }).catch(() => {});

        if (positionStore) {
          await positionStore
            .setJSON("market-prob-last-bias", {
              biasKey: nar.biasKey,
              bullPct: marketProb.bullPct,
              bearPct: marketProb.bearPct,
              firedAt: Date.now(),
            })
            .catch(() => {});
        }
      }
    }

    if (primarySignal) {
      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_CHAT_ID;
      if (bot && chat) {
        let skipPrimaryTg = false;
        if (positionStore) {
          try {
            const fp = `${tier}|${gradClass}|${macroRegime}`;
            const prevP = await positionStore.get("matrix-primary-telegram-dedupe", {
              type: "json",
            });
            if (prevP && prevP.ymd === ymdEt() && prevP.fp === fp) {
              skipPrimaryTg = true;
            }
          } catch (e) {
            console.warn("matrix primary dedupe read", e?.message || e);
          }
        }
        if (!skipPrimaryTg) {
          const msg = [
            `⚡ MATRIX SIGNAL — SPY`,
            `Variant 9 — 74% historical win rate`,
            ``,
            `Graduation: ${tier.toUpperCase()} ${gradClass}`,
            `Strength: ${signal.gradStrength}`,
            `Macro regime: ${macroRegime}`,
            ``,
            `Entry: buy ATM call spread 7-10 DTE`,
            `Stop: 1% below SPY entry`,
            `Target: 2% above entry`,
            ``,
            `Ratios: ${signal.ratios.r_4_9} | ${signal.ratios.rv_4_9} | ${signal.rv_9_21}`,
          ].join("\n");
          fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
          }).catch((e) => console.warn("matrix Telegram:", e?.message));
          if (positionStore) {
            const fp = `${tier}|${gradClass}|${macroRegime}`;
            await positionStore
              .setJSON("matrix-primary-telegram-dedupe", {
                ymd: ymdEt(),
                fp,
                at: Date.now(),
              })
              .catch(() => {});
          }
        }
      }
    }

    if (positionStore) {
      await positionStore.setJSON("matrix-signal-latest", signal).catch(() => {});
    }

    return { statusCode: 200, headers, body: JSON.stringify(signal) };
  } catch (e) {
    console.error("matrix-signal:", e?.message || e);
    return { statusCode: 200, headers, body: JSON.stringify({ error: e?.message, progressPct: 0 }) };
  }
};
