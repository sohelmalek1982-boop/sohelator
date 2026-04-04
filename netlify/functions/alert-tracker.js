const fetch = require("node-fetch");
const { getStore } = require("./lib/blobsStore.cjs");
const { getAlertCurrentPnl } = require("./lib/optionsData");
const { getMemoryStore } = require("./lib/memory.cjs");
const { forecastSetup } = require("./lib/forecast");
const { isNyRegularSessionNow } = require("./lib/marketCalendar");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradierGet(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await fetch(tradierBase() + path + (qs ? "?" + qs : ""), {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

/** Seconds since last quote update, or null if unknown. */
function quoteAgeSeconds(q) {
  if (!q) return null;
  const raw =
    q.bid_timestamp ?? q.ask_timestamp ?? q.last_quote_time ?? q.prev_bid_timestamp;
  if (raw == null) return null;
  let sec = typeof raw === "number" ? raw : Date.parse(String(raw)) / 1000;
  if (!isFinite(sec) || sec <= 0) return null;
  if (sec > 1e12) sec /= 1000;
  return Math.max(0, Date.now() / 1000 - sec);
}

function isSwingAlert(alert) {
  return (
    alert?.swingHoldOk === true ||
    alert?.holdProfile === "swing_1_3d" ||
    String(alert?.holdTypeLabel || "").includes("SWING")
  );
}

/** PnL-aware actions: swing setups get wider stop and “hold swing” until thesis breaks. */
function getRecommendedAction(alert, estimatedPnl) {
  const swing = isSwingAlert(alert);
  const stopPct = swing ? -45 : -40;

  if (estimatedPnl <= stopPct) {
    return {
      action: "EXIT — STOP HIT",
      color: "red",
      urgent: true,
      reason: swing
        ? `Down ${Math.abs(stopPct)}%+ — swing stop / thesis broken`
        : "Down 40%+ — your stop level hit",
    };
  }
  if (estimatedPnl >= 150) {
    return {
      action: "TAKE 75% OFF",
      color: "green",
      urgent: true,
      reason: `Up ${estimatedPnl.toFixed(0)}% — monster winner`,
    };
  }
  if (estimatedPnl >= 100) {
    return {
      action: "TAKE HALF OFF",
      color: "green",
      urgent: true,
      reason: `Up ${estimatedPnl.toFixed(0)}% — trail rest`,
    };
  }
  if (estimatedPnl >= 80) {
    return {
      action: "CONSIDER TAKING PROFIT",
      color: "green",
      urgent: false,
      reason: `Up ${estimatedPnl.toFixed(0)}% — at target zone`,
    };
  }
  if (estimatedPnl >= 60) {
    return {
      action: "TRAIL STOP TO +30%",
      color: "green",
      urgent: false,
      reason: "Up 60%+ — protect gains",
    };
  }
  if (estimatedPnl >= 40) {
    return {
      action: "MOVE STOP TO BREAKEVEN",
      color: "green",
      urgent: false,
      reason: "Up 40%+ — free trade now",
    };
  }
  if (estimatedPnl >= 0 && estimatedPnl < 40) {
    return {
      action: swing ? "HOLD SWING" : "HOLD — SETUP INTACT",
      color: "yellow",
      urgent: false,
      reason: swing
        ? "Swing lane — OK to carry overnight if thesis intact"
        : "Small gain — let it develop",
    };
  }
  if (estimatedPnl < 0 && estimatedPnl > stopPct) {
    if (swing) {
      return {
        action: "HOLD SWING",
        color: "orange",
        urgent: false,
        reason: "Drawdown in swing window — check structure vs chop",
      };
    }
    return {
      action: "HOLD OR CUT",
      color: "orange",
      urgent: false,
      reason: "Underwater but above stop — decide on structure",
    };
  }
  return {
    action: "REVIEW",
    color: "muted",
    urgent: false,
    reason: "Check position",
  };
}

exports.handler = async (event) => {
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

  const alertsStore = getStore('alerts');

  const keys = [];
  try {
    for await (const page of alertsStore.list({
      prefix: "alert_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        if (b.key) keys.push(b.key);
      }
    }
  } catch (e) {
    console.error("alert-tracker list", e);
  }

  const alerts = [];
  for (const k of keys) {
    try {
      const row = await alertsStore.get(k, { type: "json" });
      if (row) alerts.push(row);
    } catch {
      /* skip */
    }
  }

  alerts.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

  const tickers = [...new Set(alerts.map((a) => a.ticker).filter(Boolean))];
  let quotes = {};
  if (tickers.length && process.env.TRADIER_TOKEN) {
    try {
      const qd = await tradierGet("/v1/markets/quotes", {
        symbols: tickers.join(","),
        greeks: "false",
      });
      for (const q of normList(qd.quotes?.quote)) {
        if (q.symbol) quotes[q.symbol] = q;
      }
    } catch (e) {
      console.error("alert-tracker quotes", e);
    }
  }

  const optionPnls = await Promise.all(
    alerts.map((a) => getAlertCurrentPnl(a).catch(() => null))
  );

  let patternsAll = null;
  let memStore = null;
  try {
    memStore = getMemoryStore();
    patternsAll = await memStore.get("patterns_all_time", {
      type: "json",
    });
  } catch (e) {
    console.error("alert-tracker patterns", e);
  }

  const enriched = await Promise.all(
    alerts.map(async (alert, idx) => {
      const alertPrice =
        alert.underlyingAtAlert ??
        alert.indicators?.price ??
        alert.price ??
        0;
      const q = quotes[alert.ticker];
      const quoteAgeSec = quoteAgeSeconds(q);
      const staleQuote =
        isNyRegularSessionNow() &&
        quoteAgeSec != null &&
        quoteAgeSec > 120;
      const currentPrice = parseFloat(
        q?.last ?? q?.close ?? alert.currentUnderlying ?? 0
      );
      let underlyingPnlPct = null;
      if (alertPrice > 0 && currentPrice > 0) {
        underlyingPnlPct =
          ((currentPrice - alertPrice) / alertPrice) * 100;
      }
      const isPut =
        alert.direction === "put" ||
        (alert.option?.optType || "").toLowerCase() === "put";
      const signedMove = isPut ? -underlyingPnlPct : underlyingPnlPct;
      const delta = parseFloat(alert.indicators?.delta) || 0.45;
      let estimatedOptionPnlPct =
        underlyingPnlPct != null
          ? signedMove * Math.abs(delta) * 2
          : null;
      if (estimatedOptionPnlPct != null) {
        estimatedOptionPnlPct = Math.max(
          -100,
          Math.min(500, estimatedOptionPnlPct)
        );
      }

      const live = optionPnls[idx];
      const optionPnlPct =
        live && live.realPnlPct != null ? live.realPnlPct : null;
      const pnlForRec =
        optionPnlPct != null ? optionPnlPct : estimatedOptionPnlPct ?? underlyingPnlPct ?? 0;

      const hoursInTrade =
        alert.timestamp != null
          ? (Date.now() - alert.timestamp) / 3600000
          : null;

      const rec = getRecommendedAction(alert, pnlForRec);

      let forecastData = null;
      try {
        if (alert.id && patternsAll && memStore) {
          const snap = await memStore.get(`snapshot_${alert.id}`, {
            type: "json",
          });
          if (snap) {
            forecastData = await forecastSetup(snap, patternsAll);
          }
        }
      } catch (e) {
        console.error("forecast attach", alert.ticker, e);
      }

      return {
        ...alert,
        currentUnderlying: currentPrice || null,
        underlyingPnlPct,
        estimatedOptionPnlPct,
        liveOptionQuote: live,
        realOptionPnlPct: optionPnlPct,
        hoursInTrade,
        swingPhase:
          hoursInTrade != null && isFinite(hoursInTrade)
            ? hoursInTrade < 24
              ? "session_1"
              : hoursInTrade < 72
                ? "swing"
                : "day3_plus"
            : null,
        recommendedAction: rec.action,
        recommendedMeta: rec,
        forecastData,
        quoteAgeSeconds: quoteAgeSec,
        staleQuote,
        lastUpdated: Date.now(),
      };
    })
  );

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      count: enriched.length,
      alerts: enriched,
      updatedAt: Date.now(),
    }),
  };
};
