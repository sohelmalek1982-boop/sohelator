const { getStore } = require("@netlify/blobs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }
  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }
  const subscription = body.subscription;
  if (!subscription || !subscription.endpoint) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "subscription required" }),
    };
  }
  const store = getStore({
    name: "subscriptions",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const key = "sub_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
  await store.setJSON(key, subscription);
  return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
};
