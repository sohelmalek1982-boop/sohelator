/**
 * SOHELATOR blueprint — trade log API (Prompt 5)
 * POST: legacy memory record OR action=entered | exited
 * GET: open trades + live P&L (trade-manager)
 */

import { createRequire } from "module";
import {
  markEntered,
  markExited,
  getOpenTrades,
} from "../../src/lib/trade-manager.js";

const require = createRequire(import.meta.url);
const { recordTrade } = require("./lib/memory.js");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...cors, "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...cors }, body: "" };
  }

  if (event.httpMethod === "GET") {
    try {
      const openTrades = await getOpenTrades();
      return json(200, { success: true, openTrades });
    } catch (e) {
      console.error("log-trade GET", e);
      return json(500, { success: false, error: String(e?.message || e), openTrades: [] });
    }
  }

  if (event.httpMethod !== "POST") {
    return json(405, { success: false, error: "Use GET or POST" });
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { success: false, error: "Invalid JSON" });
  }

  const action = String(body.action || body.type || "").toLowerCase();

  if (action === "entered") {
    try {
      const alertPayload = body.alert ? { ...body.alert } : { ...body };
      delete alertPayload.action;
      delete alertPayload.type;
      const { trade, persist } = await markEntered(alertPayload);
      const openTrades = await getOpenTrades();
      return json(200, {
        success: true,
        trade,
        persist,
        openTrades,
      });
    } catch (e) {
      console.error("log-trade entered", e);
      return json(400, { success: false, error: String(e?.message || e), openTrades: [] });
    }
  }

  if (action === "exited") {
    try {
      const { trade, persist } = await markExited(
        body.tradeId,
        body.exitPrice,
        body.outcome
      );
      const openTrades = await getOpenTrades();
      return json(200, {
        success: true,
        trade,
        persist,
        openTrades,
      });
    } catch (e) {
      console.error("log-trade exited", e);
      return json(400, { success: false, error: String(e?.message || e), openTrades: [] });
    }
  }

  if (action === "open_trades" || action === "list") {
    try {
      const openTrades = await getOpenTrades();
      return json(200, { success: true, openTrades });
    } catch (e) {
      return json(500, { success: false, error: String(e?.message || e), openTrades: [] });
    }
  }

  if (!body.ticker) {
    return json(400, {
      success: false,
      error: "Provide action entered|exited|open_trades or legacy { ticker }",
      openTrades: [],
    });
  }

  try {
    const trade = await recordTrade({
      ticker: String(body.ticker).toUpperCase(),
      direction: body.direction,
      strike: body.strike,
      expiry: body.expiry,
      entryPremium: body.entryPremium,
      exitPremium: body.exitPremium,
      outcome: body.outcome,
      signalScore: body.signalScore,
      stage: body.stage,
      indicators: body.indicators,
      holdDays: body.holdDays,
      exitReason: body.exitReason,
      exitType: body.exitType,
      executionMode: body.executionMode,
      paper: body.paper,
    });
    let openTrades = [];
    try {
      openTrades = await getOpenTrades();
    } catch {
      /* optional */
    }
    return json(200, { success: true, trade, openTrades });
  } catch (e) {
    console.error(e);
    return json(500, { success: false, error: e.message || "record failed", openTrades: [] });
  }
};
