/**
 * Position tracker — blob-backed (sohelator-positions), Tradier quotes, Telegram on status change.
 * GET: list positions (openedAt desc). Exported: logAlertAsPosition, updatePositions for cheap-monitor + scan.
 */

import { getStore } from "@netlify/blobs";
import { getQuote } from "../../src/lib/tradier.js";

const BLOB_KEY = "positions";
const DEDUP_MS = 20 * 60 * 1000;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function positionsStore() {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_TOKEN;
  if (!siteID || !token) return null;
  return getStore({
    name: "sohelator-positions",
    siteID,
    token,
  });
}

export async function readPositionsMap() {
  const store = positionsStore();
  if (!store) return {};
  try {
    const raw = await store.get(BLOB_KEY, { type: "json" });
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw;
    return {};
  } catch (e) {
    console.warn("position-tracker readPositionsMap", e?.message || e);
    return {};
  }
}

export async function writePositionsMap(map) {
  const store = positionsStore();
  if (!store) throw new Error("NETLIFY_SITE_ID / NETLIFY_TOKEN required for positions");
  await store.setJSON(BLOB_KEY, map);
}

function isExitStatus(s) {
  return typeof s === "string" && s.startsWith("EXIT");
}

/** Rule-based EXIT, Grok CLOSE, or other terminal state — skip autonomous / quote churn */
export function isPositionTerminated(pos) {
  const s = String(pos?.status || "");
  return (
    isExitStatus(s) ||
    s.startsWith("CLOSED") ||
    s.includes("CLOSED ✅") ||
    s.includes("CLOSED ❌")
  );
}

function quoteLast(q) {
  const v = parseFloat(q?.last ?? q?.bid ?? q?.ask ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function computePnlAndStatus(pos, currentPrice) {
  const entry = Number(pos.entryPrice);
  const stop = Number(pos.stopPrice);
  const target = Number(pos.targetPrice);
  const dir = pos.direction === "short" ? "short" : "long";
  const prevStatus = String(pos.status || "LIVE");

  let pnlPct = 0;
  if (entry > 0 && Number.isFinite(currentPrice)) {
    if (dir === "long") {
      pnlPct = ((currentPrice - entry) / entry) * 100;
    } else {
      pnlPct = ((entry - currentPrice) / entry) * 100;
    }
  }

  const pnlDollar = entry > 0 ? (entry * pnlPct) / 100 : 0;

  if (isExitStatus(prevStatus)) {
    return { status: prevStatus, pnlPct, pnlDollar };
  }

  let status = "HOLD 🟡";
  if (dir === "long") {
    if (Number.isFinite(target) && currentPrice >= target) {
      status = "EXIT - TARGET ✅";
    } else if (Number.isFinite(stop) && currentPrice <= stop) {
      status = "EXIT - STOP ❌";
    }
  } else {
    if (Number.isFinite(target) && currentPrice <= target) {
      status = "EXIT - TARGET ✅";
    } else if (Number.isFinite(stop) && currentPrice >= stop) {
      status = "EXIT - STOP ❌";
    }
  }

  if (!isExitStatus(status)) {
    if (pnlPct > 0.5) status = "LIVE 🟢";
    else if (pnlPct < -0.3) status = "DANGER ⚠️";
    else status = "HOLD 🟡";
  }

  return { status, pnlPct, pnlDollar };
}

async function sendPositionUpdateTelegram(pos, newStatus) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  const sym = String(pos.symbol || "—");
  const dir = String(pos.direction || "long").toUpperCase();
  const currentPrice = Number(pos.currentPrice);
  const entryPrice = Number(pos.entryPrice);
  const optDesc = pos.suggestedOption?.description || "—";
  const text = (
    `📊 POSITION UPDATE\n` +
    `${sym} - ${dir}\n` +
    `Status: ${newStatus}\n` +
    `Price: $${Number.isFinite(currentPrice) ? currentPrice.toFixed(2) : "—"} | Entry: $${Number.isFinite(entryPrice) ? entryPrice.toFixed(2) : "—"}\n` +
    `P&L: ${Number(pos.pnlPct).toFixed(2)}% | $${Number(pos.pnlDollar).toFixed(2)}\n` +
    `Option: ${optDesc}`
  )
    .trim()
    .slice(0, 3900);
  try {
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.warn("position-tracker Telegram:", e?.message || e);
  }
}

/**
 * @param {Record<string, any>} alert scan alert
 */
export async function logAlertAsPosition(alert) {
  const symbol = String(alert?.symbol || "").trim().toUpperCase();
  if (!symbol) return;

  const store = positionsStore();
  if (!store) {
    console.warn("position-tracker logAlertAsPosition: no blob store");
    return;
  }

  const map = await readPositionsMap();
  const now = Date.now();

  for (const p of Object.values(map)) {
    if (String(p.symbol || "").toUpperCase() !== symbol) continue;
    if (now - Number(p.openedAt || 0) < DEDUP_MS) return;
  }

  const entry = Number(alert.entry);
  if (!Number.isFinite(entry) || entry <= 0) return;

  const openedAt = now;
  const id = `${symbol}-${openedAt}`;
  const last = Number(alert.last ?? alert.underlyingAtAlert);
  const stop = Number(alert.stop);
  const target = Number(alert.target);

  let suggestedOption = null;
  if (alert.suggestedOption && typeof alert.suggestedOption === "object") {
    suggestedOption = { ...alert.suggestedOption };
  }

  map[id] = {
    id,
    symbol,
    direction: alert.direction === "short" ? "short" : "long",
    entryPrice: entry,
    stopPrice: Number.isFinite(stop) ? stop : null,
    targetPrice: Number.isFinite(target) ? target : null,
    currentPrice: Number.isFinite(last) ? last : entry,
    score: Number(alert.score) || 0,
    playType: alert.playType || alert.playTypeLabel || "",
    suggestedOption,
    grokVerdict: String(alert.aiVerdict || ""),
    grokAnalysis: String(alert.grokAnalysis || ""),
    grokRisks: String(alert.grokRisks || ""),
    grokPlan: String(alert.grokPlan || alert.plan || ""),
    volRatio:
      alert.details?.volRatio != null && Number.isFinite(Number(alert.details.volRatio))
        ? Number(alert.details.volRatio)
        : null,
    openedAt,
    openedAtIso: new Date(openedAt).toISOString(),
    status: "LIVE",
    pnlPct: 0,
    pnlDollar: 0,
    lastUpdated: now,
  };

  try {
    await writePositionsMap(map);
  } catch (e) {
    console.warn("position-tracker logAlertAsPosition write", e?.message || e);
  }
}

export async function updatePositions() {
  if (!process.env.TRADIER_TOKEN) {
    console.warn("position-tracker updatePositions: TRADIER_TOKEN missing");
    return;
  }

  const store = positionsStore();
  if (!store) return;

  let map;
  try {
    map = await readPositionsMap();
  } catch (e) {
    console.warn("position-tracker updatePositions read", e?.message || e);
    return;
  }

  const ids = Object.keys(map);
  let changed = false;

  for (const id of ids) {
    const pos = map[id];
    if (!pos || !pos.symbol) continue;
    if (isPositionTerminated(pos)) continue;

    let currentPrice = Number(pos.currentPrice);
    try {
      const q = await getQuote(pos.symbol);
      const px = quoteLast(q);
      if (px != null) currentPrice = px;
    } catch (e) {
      console.warn("position-tracker quote", pos.symbol, e?.message || e);
    }

    const oldStatus = String(pos.status || "");
    const { status, pnlPct, pnlDollar } = computePnlAndStatus(
      { ...pos, currentPrice },
      currentPrice
    );

    const updated = {
      ...pos,
      currentPrice,
      pnlPct,
      pnlDollar,
      status,
      lastUpdated: Date.now(),
    };

    if (oldStatus !== status) {
      await sendPositionUpdateTelegram(updated, status);
    }

    map[id] = updated;
    changed = true;
  }

  if (changed) {
    try {
      await writePositionsMap(map);
    } catch (e) {
      console.warn("position-tracker updatePositions write", e?.message || e);
    }
  }
}

export async function handler(event) {
  const headers = { ...cors, "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "GET only" }),
    };
  }

  try {
    const map = await readPositionsMap();
    const positions = Object.values(map).sort(
      (a, b) => Number(b.openedAt || 0) - Number(a.openedAt || 0)
    );
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, count: positions.length, positions }),
    };
  } catch (e) {
    console.error("position-tracker GET", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
}
