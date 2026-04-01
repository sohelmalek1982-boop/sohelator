/**
 * SOHELATOR blueprint — Tradier REST helpers (fetch only; server-side via Netlify env).
 * Uses TRADIER_TOKEN + TRADIER_ENV (sandbox|production) like the rest of SOHELATOR.
 */

import {
  normList,
  num,
  parseHistoryDays,
  parseTimesalesRows,
} from "./utils.js";

export function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

/**
 * Low-level GET (returns parsed JSON).
 * @param {string} path
 * @param {Record<string, string | number | boolean>} [params]
 */
export async function tradierGet(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  ).toString();
  const url = tradierBase() + path + (qs ? "?" + qs : "");
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Tradier ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

/** @param {string} symbol */
export async function getQuote(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return null;
  const j = await tradierGet("/v1/markets/quotes", {
    symbols: sym,
    greeks: "false",
  });
  const q = normList(j.quotes?.quote)[0];
  return q || null;
}

/**
 * Intraday OHLCV bars (session_filter=open matches existing SOHELATOR scanners).
 * @param {string} symbol
 * @param {string} [interval]
 * @param {number} [days]
 */
export async function getTimesales(symbol, interval = "5min", days = 2) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return [];
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const j = await tradierGet("/v1/markets/timesales", {
    symbol: sym,
    interval,
    start: ymd(start),
    end: ymd(end),
    session_filter: "open",
  });
  return parseTimesalesRows(j.series?.data);
}

/**
 * Daily bars (last N calendar days window).
 * @param {string} symbol
 * @param {number} [days]
 */
export async function getDailyHistory(symbol, days = 30) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return [];
  const end = new Date();
  const start = new Date(end.getTime() - (days + 5) * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const j = await tradierGet("/v1/markets/history", {
    symbol: sym,
    interval: "daily",
    start: ymd(start),
    end: ymd(end),
  });
  return parseHistoryDays(j.history?.day).slice(-days);
}

/**
 * True if symbol has at least one expiration and a non-empty chain snapshot.
 * @param {string} symbol
 */
export async function hasTradableOptions(symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return false;
  try {
    const exp = await tradierGet("/v1/markets/options/expirations", {
      symbol: sym,
      includeAllRoots: "true",
    });
    const dates = normList(exp.expirations?.date || exp.expirations?.expiration)
      .map(String)
      .sort();
    const pick = dates.find((d) => {
      const dte = Math.round(
        (new Date(d + "T12:00:00Z").getTime() - Date.now()) / 86400000
      );
      return dte >= 0;
    });
    if (!pick) return false;
    const chain = await tradierGet("/v1/markets/options/chains", {
      symbol: sym,
      expiration: pick,
      greeks: "false",
    });
    const opts = normList(chain.options?.option);
    return opts.length > 0;
  } catch {
    return false;
  }
}

/**
 * Full option chain for one expiration (normalized option list).
 * @param {string} symbol
 * @param {string} expiration YYYY-MM-DD
 */
export async function getOptionChain(symbol, expiration) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym || !expiration) return { expiration: "", options: [] };
  const j = await tradierGet("/v1/markets/options/chains", {
    symbol: sym,
    expiration: String(expiration).slice(0, 10),
    greeks: "true",
  });
  const opts = normList(j.options?.option).map((o) => ({
    symbol: o.symbol,
    strike: num(o.strike),
    option_type: o.option_type,
    bid: num(o.bid),
    ask: num(o.ask),
    open_interest: num(o.open_interest ?? o.openInterest),
    volume: num(o.volume),
    last: num(o.last),
  }));
  return { expiration: String(expiration).slice(0, 10), options: opts };
}

/**
 * Rank underlying symbols by total open interest on the nearest listed expiry (max 80).
 * @param {string[]} fullList
 * @returns {Promise<string[]>}
 */
export async function getLiquidOptionsWatchlist(fullList) {
  const uniq = [
    ...new Set(
      (fullList || []).map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)
    ),
  ];
  if (!uniq.length) return [];

  const scored = [];

  for (const sym of uniq) {
    try {
      const exp = await tradierGet("/v1/markets/options/expirations", {
        symbol: sym,
        includeAllRoots: "true",
      });
      const dates = normList(exp.expirations?.date || exp.expirations?.expiration)
        .map(String)
        .sort();
      const pick =
        dates.find((d) => {
          const dte = Math.round(
            (new Date(d + "T12:00:00Z").getTime() - Date.now()) / 86400000
          );
          return dte >= 0;
        }) || dates[0];
      if (!pick) continue;

      const chain = await tradierGet("/v1/markets/options/chains", {
        symbol: sym,
        expiration: pick,
        greeks: "false",
      });
      const opts = normList(chain.options?.option);
      let liq = 0;
      for (const o of opts) {
        liq += num(o.open_interest ?? o.openInterest);
        liq += num(o.volume) * 0.1;
      }
      scored.push({ symbol: sym, liquidity: liq });
    } catch {
      /* skip symbol */
    }
  }

  scored.sort((a, b) => b.liquidity - a.liquidity);
  return scored.slice(0, 80).map((x) => x.symbol);
}
