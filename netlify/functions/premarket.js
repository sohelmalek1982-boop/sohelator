/**
 * SOHELATOR blueprint — pre-market snapshot: quick 7d backtest edge + top 5 watchlist
 * with projected EV and historical pattern notes (Tradier + backtester).
 */

import { runBacktest, findSimilarSetups } from "../../src/lib/backtester.js";
import {
  applyOptimizedParams,
  getOptimizedParams,
} from "../../src/lib/scanner-rules.js";
import {
  getLiquidOptionsWatchlist,
  getTimesales,
  getDailyHistory,
} from "../../src/lib/tradier.js";
import { callGrok } from "../../src/lib/grok.js";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const DEFAULT_UNIVERSE = [
  "SPY",
  "QQQ",
  "IWM",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "META",
  "AMD",
];

/** Prompt 8 — Grok only 8:00–16:00 ET weekdays */
function minutesEt(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}

function isWeekdayEt(d) {
  const w = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
  return w !== "Sat" && w !== "Sun";
}

function isEtGrokWindow(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= 8 * 60 && t <= 16 * 60;
}

async function callGrokPremarketWithFallback(prompt, maxTok) {
  const expensiveModel =
    process.env.GROK_MODEL_EXPENSIVE || "grok-4.20-0309-reasoning";
  const cheapModel =
    process.env.GROK_MODEL_CHEAP || "grok-4-1-fast-reasoning";
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const text = await callGrok(expensiveModel, prompt, maxTok);
      return { text, health: "ok" };
    } catch (e) {
      lastErr = e;
      console.warn("premarket Grok expensive attempt", attempt + 1, e?.message || e);
    }
  }
  try {
    console.warn("premarket Grok: falling back to cheap model");
    const text = await callGrok(cheapModel, prompt, maxTok);
    return { text, health: "fallback_cheap" };
  } catch (e2) {
    throw lastErr || e2;
  }
}

export const handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "GET only" }),
    };
  }

  const snapshot = {
    asOf: new Date().toISOString(),
    futuresBias: {
      note:
        "SOHELATOR blueprint — wire /ES /NQ (or Tradier futures) for real overnight bias",
      bias: "neutral",
      es: null,
      nq: null,
    },
    backtest7d: null,
    watchlistTop5: [],
  };

  if (!process.env.TRADIER_TOKEN) {
    snapshot.note =
      "TRADIER_TOKEN not set — backtest / watchlist insights unavailable.";
    return { statusCode: 200, headers, body: JSON.stringify(snapshot) };
  }

  try {
    await applyOptimizedParams(true);
    const report = await runBacktest(7);
    snapshot.backtest7d = {
      ev: report.ev,
      winRate: report.winRate,
      avgR: report.avgR,
      totalSetups: report.totalSetups,
      playTypeAccuracy: report.playTypeAccuracy,
      projectedEdgeToday:
        "SOHELATOR blueprint: projected edge from 7d walk-forward sample (not a guarantee).",
    };

    const liquid = (await getLiquidOptionsWatchlist(DEFAULT_UNIVERSE)).slice(
      0,
      8
    );
    const ranked = liquid
      .map((sym) => {
        const bs = report.bySymbol[sym];
        return {
          symbol: sym,
          winRate: bs && !bs.error ? bs.winRate : 0,
          trades: bs && !bs.error ? bs.trades : 0,
        };
      })
      .sort((a, b) => b.winRate - a.winRate)
      .slice(0, 5);

    const P = getOptimizedParams();
    const evBase = report.ev || 0;

    for (const row of ranked) {
      let similarPatterns =
        "Run full /api/scan POST for similarity rows — optional warm path failed.";
      try {
        const bars5 = await getTimesales(row.symbol, "5min", 5);
        const daily = await getDailyHistory(row.symbol, 90);
        if (bars5.length >= 10) {
          const sim = await findSimilarSetups(
            { symbol: row.symbol, bars: bars5, dailyBars: daily },
            5
          );
          const wins = sim.filter((s) => s.win).length;
          similarPatterns = `${sim.length} near matches, ~${sim.length ? Math.round((wins / sim.length) * 100) : 0}% wins in cache. ${sim[0]?.patternNote || ""}`;
        }
      } catch (e) {
        similarPatterns = String(e?.message || e).slice(0, 120);
      }

      snapshot.watchlistTop5.push({
        symbol: row.symbol,
        projectedEv: Math.round((evBase * (0.85 + row.winRate * 0.3)) * 1000) / 1000,
        winRateSample: row.winRate,
        setupsInSample: row.trades,
        similarHistoricalPatterns: similarPatterns,
        minScore: P.minScore,
      });
    }

    /* Prompt 8 — Grok 8am–4pm ET; 2× expensive + cheap fallback */
    if (process.env.GROK_API_KEY) {
      if (!isEtGrokWindow(new Date())) {
        snapshot.grokBriefStatus = "outside_window";
        snapshot.aiBrief =
          "Grok brief skipped — outside SOHELATOR window (8:00am–4:00pm ET, weekdays).";
      } else {
        try {
          const briefPrompt = `Write a short pre-market brief (4–7 lines) for a driver: lead with edge vs risk, watchlist focus, no JSON. Snapshot:\n${JSON.stringify(snapshot)}`;
          const { text, health } = await callGrokPremarketWithFallback(
            briefPrompt,
            900
          );
          snapshot.aiBrief = text;
          snapshot.grokBriefStatus = health;
          // Auto-push brief to Telegram
          const _tgBot = process.env.TELEGRAM_BOT_TOKEN;
          const _tgChat = process.env.TELEGRAM_CHAT_ID;
          if (_tgBot && _tgChat && snapshot.aiBrief && snapshot.grokBriefStatus === "ok") {
            const _today = new Date().toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              weekday: "short",
              month: "short",
              day: "numeric",
            });
            const _briefMsg = [
              `🌅 SOHELATOR PREMARKET — ${_today}`,
              ``,
              snapshot.aiBrief,
              ``,
              `SPY: $${snapshot.futuresBias?.es || "—"} | Bias: ${snapshot.futuresBias?.bias || "neutral"}`,
              `Next: 9:25 AM checkpoint`,
            ]
              .join("\n")
              .slice(0, 4000);

            fetch(`https://api.telegram.org/bot${_tgBot}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: _tgChat,
                text: _briefMsg,
                disable_web_page_preview: true,
              }),
            }).catch((e) => console.warn("premarket auto-Telegram:", e?.message));
          }
        } catch (e) {
          console.warn("premarket Grok (all attempts failed):", e?.message || e);
          snapshot.grokBriefStatus = "error";
          snapshot.aiBrief = `Brief unavailable: ${e?.message || e}`;
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(snapshot),
    };
  } catch (e) {
    console.error("premarket", e);
    snapshot.error = String(e?.message || e);
    return { statusCode: 200, headers, body: JSON.stringify(snapshot) };
  }
};
