const { getStore } = require("@netlify/blobs");

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

  const store = getStore("morning-scans");
  const learningStore = getStore("learnings");

  const [scan925, scan955, eodLatest, runningStats] = await Promise.all([
    store.get("scan_925_latest", { type: "json" }),
    store.get("scan_955_latest", { type: "json" }),
    learningStore.get("eod_latest", { type: "json" }),
    learningStore.get("running_stats", { type: "json" }),
  ]);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      scan925,
      scan955,
      eodLatest,
      runningStats,
      lastUpdated: Date.now(),
    }),
  };
};
