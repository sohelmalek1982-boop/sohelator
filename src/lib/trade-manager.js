/**
 * SOHELATOR blueprint — trade management (Prompt 5)
 * Persists open/closed trades via Netlify Blobs when configured; merges with static public/trade_log.json at read time.
 */

import { getStore } from "@netlify/blobs";

const STORE_NAME = "sohelator-trade-log";
const BLOB_KEY = "trade_log_state";

function siteUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(/\/$/, "");
}

function num(x, fb = 0) {
  const n = parseFloat(String(x));
  return Number.isFinite(n) ? n : fb;
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

function tradeLogStore() {
  return getStore({
    name: STORE_NAME,
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
}

function normalizeLogShape(raw) {
  if (raw == null) return { version: 2, trades: [] };
  if (Array.isArray(raw)) return { version: 1, trades: raw };
  if (typeof raw === "object" && Array.isArray(raw.trades)) {
    return { version: raw.version || 2, trades: raw.trades };
  }
  return { version: 2, trades: [] };
}

async function blobRead() {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) return null;
  try {
    const store = tradeLogStore();
    const j = await store.get(BLOB_KEY, { type: "json" });
    return j;
  } catch (e) {
    console.warn("trade-manager blobRead", e?.message || e);
    return null;
  }
}

async function blobWrite(state) {
  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) {
    return { saved: false, note: "NETLIFY_SITE_ID / NETLIFY_TOKEN not set — open trades only in memory for this request" };
  }
  try {
    const store = tradeLogStore();
    await store.setJSON(BLOB_KEY, state);
    return { saved: true, blob: true };
  } catch (e) {
    return { saved: false, error: String(e?.message || e) };
  }
}

async function fetchPublicTradeLog() {
  const base = siteUrl();
  if (!base) return null;
  try {
    const r = await fetch(`${base}/trade_log.json`, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function readMergedState() {
  const fromBlob = await blobRead();
  const fromPublic = await fetchPublicTradeLog();
  const envJson = process.env.TRADE_LOG_JSON
    ? (() => {
        try {
          return JSON.parse(process.env.TRADE_LOG_JSON);
        } catch {
          return null;
        }
      })()
    : null;

  const a = normalizeLogShape(fromBlob);
  const b = normalizeLogShape(fromPublic);
  const c = normalizeLogShape(envJson);

  const byId = new Map();
  for (const t of [...c.trades, ...b.trades, ...a.trades]) {
    if (t && t.id) byId.set(t.id, t);
  }
  return { version: 2, trades: Array.from(byId.values()) };
}

async function persistState(state) {
  const w = await blobWrite(state);
  return w;
}

function normalizeAlert(alert) {
  if (!alert || typeof alert !== "object") alert = {};
  const symbol = String(alert.symbol || alert.ticker || alert.underlying || "").toUpperCase().trim();
  const entryPrice = num(alert.entryPrice ?? alert.entry ?? alert.price ?? alert.last, 0);
  const stop = num(alert.stop ?? alert.stopLoss, 0);
  const target = num(alert.target ?? alert.takeProfit, 0);
  const playType = String(alert.playType || alert.stage || alert.stageLabel || "SETUP");
  const riskPct = num(alert.riskPct, 1);
  const direction =
    alert.direction ||
    (String(alert.bias || "").toLowerCase().includes("bear") ? "SHORT" : "LONG");
  return { symbol, entryPrice, stop, target, playType, riskPct, direction, raw: alert };
}

function oneR(trade) {
  const entry = num(trade.entryPrice);
  const stop = num(trade.stop);
  const risk = Math.abs(entry - stop);
  if (risk < 1e-9) return Math.max(num(trade.entryPrice) * 0.0025, 0.01);
  return risk;
}

function computeLiveR(trade, lastPrice) {
  const entry = num(trade.entryPrice);
  const r = oneR(trade);
  const dir = String(trade.direction || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
  return (dir * (lastPrice - entry)) / r;
}

function computeRealizedR(trade, exitPrice) {
  const entry = num(trade.entryPrice);
  const r = oneR(trade);
  const dir = String(trade.direction || "LONG").toUpperCase() === "SHORT" ? -1 : 1;
  return (dir * (exitPrice - entry)) / r;
}

async function fetchLastQuotes(symbols) {
  const token = process.env.TRADIER_TOKEN;
  const uniq = [...new Set(symbols.map((s) => String(s).toUpperCase()).filter(Boolean))];
  if (!token || !uniq.length) return {};
  try {
    const url = `${tradierBase()}/v1/markets/quotes?symbols=${encodeURIComponent(uniq.join(","))}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const j = await res.json();
    const map = {};
    for (const q of normList(j.quotes?.quote)) {
      const sym = String(q.symbol || "").toUpperCase();
      const last = num(q.last ?? q.bid ?? q.ask ?? q.close, 0);
      if (sym) map[sym] = last;
    }
    return map;
  } catch (e) {
    console.warn("trade-manager quotes", e?.message || e);
    return {};
  }
}

/** Tradier account positions → rough % P&L by underlying (optional). */
async function fetchUnderlyingPositionPnlPct() {
  const acc = process.env.TRADIER_ACCOUNT_ID;
  const token = process.env.TRADIER_TOKEN;
  if (!acc || !token) return {};
  try {
    const url = `${tradierBase()}/v1/accounts/${acc}/positions`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const j = await res.json();
    const map = {};
    for (const p of normList(j.positions?.position)) {
      const u = String(p.underlying_symbol || "").toUpperCase().trim();
      if (!u) continue;
      const cost = Math.abs(num(p.cost_basis, 0));
      const mv = num(p.market_value, 0);
      const plPct = cost ? ((mv - cost) / cost) * 100 : 0;
      map[u] = plPct;
    }
    return map;
  } catch {
    return {};
  }
}

/**
 * Blueprint-driven action chips: historical patience + current R.
 * @param {object} trade Enriched trade (may include livePnlR, historicalSummary).
 * @returns {{ id: string, label: string, reason: string }[]}
 */
export function generateDynamicActions(trade) {
  const r = num(trade.livePnlR, 0);
  const hist = String(trade.historicalSummary || trade.alertSnapshot?.historicalSummary || "");
  const play = String(trade.playType || "").toUpperCase();
  const actions = [];

  actions.push({
    id: "HOLD",
    label: "HOLD",
    reason: hist
      ? `Pattern note: ${hist.slice(0, 120)}${hist.length > 120 ? "…" : ""}`
      : "No adverse move vs blueprint stop — let edge play out unless thesis breaks.",
  });

  if (r >= 0.5) {
    actions.push({
      id: "TP_HALF",
      label: "TAKE PROFIT (half)",
      reason: `Up ~${r.toFixed(2)}R — blueprint: bank partial into strength (${play || "setup"}).`,
    });
  }
  if (r >= 1) {
    actions.push({
      id: "TP_FULL",
      label: "TAKE PROFIT (full)",
      reason: `≥ +1R — historical scalps often give back extension; full exit locks blueprint edge.`,
    });
  }

  if (r > -0.25 && r < 0.75) {
    actions.push({
      id: "TIGHTEN_STOP",
      label: "TIGHTEN STOP",
      reason: "Chop zone vs target — trail to breakeven+ or last swing low/high per playbook.",
    });
  }

  const exitReason =
    r <= -0.35
      ? "Approaching / past -1R — blueprint: cut noise; reassess rather than widen risk."
      : "Flat or thesis invalidated — exit and wait for next SOHELATOR signal.";
  actions.push({ id: "EXIT_NOW", label: "EXIT NOW", reason: exitReason });

  return actions;
}

/**
 * Placeholder for Tradier options chain greeks (delta/gamma/theta/vega).
 */
export async function getLiveGreeks(symbol, optionDetails) {
  return {
    placeholder: true,
    symbol: String(symbol || "").toUpperCase(),
    optionDetails: optionDetails || null,
    note: "Tradier options chain greeks — wire /markets/options/chains in a later prompt.",
    delta: null,
    gamma: null,
    theta: null,
    vega: null,
  };
}

export async function markEntered(alert) {
  const n = normalizeAlert(alert);
  if (!n.symbol) throw new Error("alert.symbol or ticker required");

  const state = await readMergedState();
  const id = `tm_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const trade = {
    id,
    status: "open",
    enteredAt: Date.now(),
    enteredAtIso: new Date().toISOString(),
    symbol: n.symbol,
    entryPrice: n.entryPrice,
    stop: n.stop,
    target: n.target,
    playType: n.playType,
    riskPct: n.riskPct,
    direction: n.direction,
    alertSnapshot: n.raw,
    historicalSummary: n.raw.historicalSummary || null,
    drivingText: n.raw.drivingText || null,
  };

  state.trades = [...state.trades.filter((t) => t.id !== id), trade];
  const persist = await persistState(state);
  return { trade, persist };
}

export async function markExited(tradeId, exitPrice, outcome) {
  const state = await readMergedState();
  const id = String(tradeId || "");
  const idx = state.trades.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error("trade not found: " + id);

  const t = state.trades[idx];
  if (t.status !== "open") throw new Error("trade already closed");

  const x = num(exitPrice);
  const realizedR = computeRealizedR(t, x);
  const closed = {
    ...t,
    status: "closed",
    exitedAt: Date.now(),
    exitedAtIso: new Date().toISOString(),
    exitPrice: x,
    outcome: String(outcome || "flat").toLowerCase(),
    realizedR,
  };

  state.trades[idx] = closed;
  const persist = await persistState(state);
  return { trade: closed, persist };
}

export async function getOpenTrades() {
  const state = await readMergedState();
  const open = state.trades.filter((t) => t.status === "open");
  const symbols = open.map((t) => t.symbol).filter(Boolean);
  const quotes = await fetchLastQuotes(symbols);
  const posPnl = await fetchUnderlyingPositionPnlPct();

  const out = [];
  for (const t of open) {
    const sym = t.symbol;
    let lastPrice = num(quotes[sym], 0);
    if (!lastPrice) lastPrice = num(t.entryPrice);

    const posPct = posPnl[sym];
    const livePnlR = computeLiveR(t, lastPrice);
    let livePnlPct = num(t.entryPrice) ? ((lastPrice - num(t.entryPrice)) / Math.abs(num(t.entryPrice))) * 100 : 0;
    if (String(t.direction || "LONG").toUpperCase() === "SHORT") {
      livePnlPct = -livePnlPct;
    }
    if (posPct != null && Number.isFinite(posPct)) {
      livePnlPct = posPct;
    }

    const enriched = {
      ...t,
      lastPrice,
      livePnlPct: Math.round(livePnlPct * 1000) / 1000,
      livePnlR: Math.round(livePnlR * 1000) / 1000,
      pnlSource: posPct != null ? "tradier_positions" : "quote_vs_entry",
      greeks: await getLiveGreeks(sym, t.alertSnapshot?.option || t.alertSnapshot?.legs),
      actions: generateDynamicActions({
        ...t,
        livePnlR,
        lastPrice,
      }),
    };
    out.push(enriched);
  }

  return out;
}
