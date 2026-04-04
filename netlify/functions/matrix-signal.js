import { getTimesales, getDailyHistory } from "../../src/lib/tradier.js";
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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
      recommendation: primarySignal
        ? "PRIMARY SIGNAL — enter ATM call spread 7-10 DTE"
        : secondarySignal
          ? "SECONDARY SIGNAL — monitor for confirmation"
          : `Building: ${gradClass} ${tier} tier`,
    };

    if (primarySignal) {
      const bot = process.env.TELEGRAM_BOT_TOKEN;
      const chat = process.env.TELEGRAM_CHAT_ID;
      if (bot && chat) {
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
          `Ratios: ${signal.ratios.r_4_9} | ${signal.ratios.rv_4_9} | ${signal.ratios.rv_9_21}`,
        ].join("\n");
        fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chat, text: msg, disable_web_page_preview: true }),
        }).catch((e) => console.warn("matrix Telegram:", e?.message));
      }
    }

    if (process.env.NETLIFY_SITE_ID && process.env.NETLIFY_TOKEN) {
      const store = getStore({
        name: "sohelator-positions",
        siteID: process.env.NETLIFY_SITE_ID,
        token: process.env.NETLIFY_TOKEN,
      });
      await store.setJSON("matrix-signal-latest", signal).catch(() => {});
    }

    return { statusCode: 200, headers, body: JSON.stringify(signal) };
  } catch (e) {
    console.error("matrix-signal:", e?.message || e);
    return { statusCode: 200, headers, body: JSON.stringify({ error: e?.message, progressPct: 0 }) };
  }
};
