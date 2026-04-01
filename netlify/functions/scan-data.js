const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { getJobHealth } = require("./lib/jobHealth");

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradierClock() {
  const token = process.env.TRADIER_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(tradierBase() + "/v1/markets/clock", {
      headers: {
        Authorization: "Bearer " + token,
        Accept: "application/json",
      },
    });
    const j = await res.json();
    return j.clock || j;
  } catch {
    return null;
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

/** Booleans only — no secrets. Used by SCAN tab readiness strip. */
function getPipelineStatus() {
  return {
    tradier: !!process.env.TRADIER_TOKEN,
    tradierAccount: !!process.env.TRADIER_ACCOUNT_ID,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    email: !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL),
    webPush: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  };
}

function emptyScanPayload(extra = {}) {
  return {
    scan925: null,
    scan955: null,
    eodLatest: null,
    runningStats: null,
    jobHealth: {},
    lastScan: null,
    marketClock: null,
    lastUpdated: Date.now(),
    blobsConfigured: false,
    blobsMessage:
      "Add NETLIFY_SITE_ID (Site settings → General → Site details) and NETLIFY_TOKEN (User settings → Applications → Personal access tokens with Blobs scope) in Netlify → Site → Environment variables. Without them, scheduled scans cannot save and this feed stays empty.",
    pipelineStatus: getPipelineStatus(),
    ...extra,
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

  const siteID = process.env.NETLIFY_SITE_ID;
  const token = process.env.NETLIFY_TOKEN;
  const blobsConfigured = !!(siteID && token);

  let marketClock = null;
  try {
    marketClock = await tradierClock();
  } catch {
    /* ignore */
  }

  if (!blobsConfigured) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        emptyScanPayload({ marketClock, blobsConfigured: false })
      ),
    };
  }

  try {
    const store = getStore({
      name: "morning-scans",
      siteID,
      token,
    });
    const learningStore = getStore({
      name: "learnings",
      siteID,
      token,
    });
    const scannerStore = getStore({
      name: "scanner",
      siteID,
      token,
    });

    const [scan925, scan955, eodLatest, runningStats, jobHealth, lastScan] =
      await Promise.all([
        store.get("scan_925_latest", { type: "json" }),
        store.get("scan_955_latest", { type: "json" }),
        learningStore.get("eod_latest", { type: "json" }),
        learningStore.get("running_stats", { type: "json" }),
        getJobHealth(),
        scannerStore.get("last_scan", { type: "json" }),
      ]);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        scan925,
        scan955,
        eodLatest,
        runningStats,
        jobHealth,
        lastScan,
        marketClock,
        lastUpdated: Date.now(),
        blobsConfigured: true,
        pipelineStatus: getPipelineStatus(),
      }),
    };
  } catch (e) {
    console.error("scan-data blobs", e);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(
        emptyScanPayload({
          marketClock,
          blobsConfigured: true,
          blobsError: String(e.message || e).slice(0, 400),
        })
      ),
    };
  }
};
