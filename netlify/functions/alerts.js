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
    return { statusCode: 405, headers, body: JSON.stringify({ error: "GET only" }) };
  }

  const alertsStore = getStore({
    name: "alerts",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const scannerStore = getStore({
    name: "scanner",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });

  const pending = [];
  const toDelete = [];
  try {
    for await (const page of alertsStore.list({
      prefix: "pending_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        try {
          const data = await alertsStore.get(b.key, { type: "json" });
          if (data) {
            pending.push(data);
            toDelete.push(b.key);
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch (e) {
    console.error("alerts list", e);
  }
  for (const k of toDelete) {
    try {
      await alertsStore.delete(k);
    } catch {
      /* skip */
    }
  }

  let last_scan = null;
  let history = [];
  try {
    last_scan = await scannerStore.get("last_scan", { type: "json" });
  } catch {
    /* none */
  }
  try {
    history = await scannerStore.get("alert_history", { type: "json" });
    if (!Array.isArray(history)) history = [];
  } catch {
    history = [];
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      pending,
      last_scan,
      history: history.slice(0, 10),
    }),
  };
};
