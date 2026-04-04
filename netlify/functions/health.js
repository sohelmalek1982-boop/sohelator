const fetch = require("node-fetch");
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
  } catch (e) {
    console.error("health tradierClock", e);
    return null;
  }
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

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
  let optimizedParams = null;
  let optimizedParamsReset = false;
  if (blobsConfigured) {
    try {
      const mod = await import("../../src/lib/scanner-rules.js");
      const { getStore } = await import("@netlify/blobs");
      const { SAFE_OPTIMIZED_PARAMS_BLOB } = mod;
      await mod.applyOptimizedParams(true);
      let params = mod.getOptimizedParams();
      const paramsNeedReset =
        (params.adxThreshold || 999) < 18 ||
        (params.sectorRSBonus || 0) > 12 ||
        (params.minScore || 0) < 70;
      if (paramsNeedReset) {
        console.warn(
          "health: optimized params out of bounds — writing safe blob defaults"
        );
        const store = getStore('sohelator-learning');
        await store.setJSON("optimized_params", SAFE_OPTIMIZED_PARAMS_BLOB);
        await mod.applyOptimizedParams(true);
        params = mod.getOptimizedParams();
        optimizedParamsReset = true;
        console.log("health: reset params to safe defaults", SAFE_OPTIMIZED_PARAMS_BLOB);
      }
      optimizedParams = {
        adxThreshold: params.adxThreshold,
        sectorRSBonus: params.sectorRSBonus,
        minScore: params.minScore,
        evThreshold: params.evThreshold,
        higherTFPenaltyMax: params.higherTFPenaltyMax,
      };
    } catch (e) {
      console.warn("health optimized params", e?.message || e);
    }
  }
  const [jobHealth, clock] = await Promise.all([
    getJobHealth(),
    tradierClock(),
  ]);
  const pipelineStatus = {
    tradier: !!process.env.TRADIER_TOKEN,
    tradierAccount: !!process.env.TRADIER_ACCOUNT_ID,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    telegram: !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID),
    email: !!(process.env.RESEND_API_KEY && process.env.ALERT_EMAIL),
    webPush: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  };
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      blobsConfigured,
      tradierConfigured: !!process.env.TRADIER_TOKEN,
      pipelineStatus,
      jobHealth,
      marketClock: clock,
      optimizedParams,
      optimizedParamsReset,
      at: Date.now(),
    }),
  };
};
