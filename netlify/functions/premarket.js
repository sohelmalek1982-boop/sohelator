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
import { getMarketTapeSnapshot } from "../../src/lib/marketTape.js";
import { callClaudeWithFallback } from "../../src/lib/claude.js";

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

/** Prompt 8 — Claude only 8:00–16:00 ET weekdays */
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

async function callClaudePremarketWithFallback(prompt, maxTok) {
  try {
    const text = await callClaudeWithFallback(prompt, maxTok);
    return { text, health: "ok" };
  } catch (e) {
    console.warn("premarket Claude failed:", e?.message || e);
    return { text: "", health: "error" };
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

    try {
      snapshot.marketTape = await getMarketTapeSnapshot();
    } catch (e) {
      console.warn("premarket marketTape:", e?.message || e);
      snapshot.marketTape = null;
    }

    /* Prompt 8 — Claude 8am–4pm ET; expensive + cheap fallback */
    if (process.env.ANTHROPIC_API_KEY) {
      if (!isEtGrokWindow(new Date())) {
        snapshot.grokBriefStatus = "outside_window";
        snapshot.aiBrief =
          "Claude brief skipped — outside SOHELATOR window (8:00am–4:00pm ET, weekdays).";
      } else {
        try {
          const briefPrompt = `You are Sohel's pre-market scanner: read the tape, then tell him how to make money today and what to watch out for.

Use the JSON snapshot below plus general market knowledge. Do NOT invent prices or events not supported by the data. This is idea generation, not personalized investment advice.

Write a decisive briefing with EXACTLY these Markdown sections (headings as shown):

## WHAT'S GOING ON
Scan the market: indices (SPY/QQQ/IWM/DIA), VIX, macro (GLD/TLT/HYG) from marketTape when present, sector heat (marketTape.sectorsHot vs sectorsCold), and backtest edge summary. One clear picture of the morning.

## BEST WAYS TO MAKE $ TODAY
Practical edge: where leadership, rotation, and the watchlistTop5 names suggest the best risk/reward *styles* for today (e.g. follow strength in X, avoid catching knives in Y). Tie each watchlist symbol to why it could work and what would confirm it. No guarantees — be specific.

## BE CAREFUL
What can hurt you today: crowded trades, macro/VIX landmines, low edge, things that look good but aren't. What to skip or size down.

## WATCH / FIRST HOUR
Short bullets: what to monitor right after the open (indices, VIX, key sectors, top names).

Rules: No JSON in the answer. No filler. Max ~900 words. Plain text + Markdown headings only.

SNAPSHOT JSON:
${JSON.stringify(snapshot)}`;
          const text = await callClaudeWithFallback(briefPrompt, 2800);
          snapshot.aiBrief = text;
          snapshot.grokBriefStatus = "ok";
          const _bot = process.env.TELEGRAM_BOT_TOKEN;
          const _chat = process.env.TELEGRAM_CHAT_ID;
          if (_bot && _chat && snapshot.aiBrief) {
            const _d = new Date().toLocaleDateString("en-US", {
              timeZone: "America/New_York",
              weekday: "short",
              month: "short",
              day: "numeric",
            });
            fetch(`https://api.telegram.org/bot${_bot}/sendMessage`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: _chat,
                text: `🌅 SOHELATOR PREMARKET — morning brief\n${_d}\n━━━━━━━━━━━━━━━━━━━━━\n\n${snapshot.aiBrief}\n\nNext: 9:25 AM`.slice(0, 4000),
                disable_web_page_preview: true,
              }),
            }).catch((e) => console.warn("premarket Telegram:", e?.message));
          }
        } catch (e) {
          console.warn("premarket Claude (all attempts failed):", e?.message || e);
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
