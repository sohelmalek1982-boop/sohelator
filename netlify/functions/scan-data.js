const fetch = require("node-fetch");
const { getStore } = require("./lib/blobsStore.cjs");
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
  "Cache-Control": "private, no-store, must-revalidate",
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
    brief1pm: null,
    scan955: null,
    eodLatest: null,
    runningStats: null,
    jobHealth: {},
    lastScan: null,
    marketClock: null,
    lastUpdated: Date.now(),
    blobsConfigured: false,
    blobsMessage:
      "This feed needs Netlify Functions runtime (blobs use built-in credentials on deploy). Local or missing NETLIFY_SITE_ID: scheduled scans may not persist and this feed can stay empty.",
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

  const blobsConfigured =
    process.env.NETLIFY === "true" || !!process.env.NETLIFY_SITE_ID;

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
    const store = getStore('morning-scans');
    const learningStore = getStore('learnings');
    const scannerStore = getStore('scanner');

    const [
      scan925,
      brief1pm,
      scan955,
      eodLatest,
      runningStats,
      jobHealth,
      lastHudScan,
      lastScanLegacy,
    ] = await Promise.all([
      store.get("scan_925_latest", { type: "json" }),
      store.get("brief_1pm_latest", { type: "json" }),
      store.get("scan_955_latest", { type: "json" }),
      learningStore.get("eod_latest", { type: "json" }),
      learningStore.get("running_stats", { type: "json" }),
      getJobHealth(),
      scannerStore.get("last_hud_scan", { type: "json" }),
      scannerStore.get("last_scan", { type: "json" }),
    ]);

    const lastScan =
      lastHudScan != null && lastHudScan.success !== false
        ? lastHudScan
        : lastScanLegacy;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        scan925,
        brief1pm,
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
