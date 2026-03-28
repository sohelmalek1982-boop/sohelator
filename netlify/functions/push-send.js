const { sendPushToAll } = require("./lib/pushAll");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Push-Secret",
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
  const secret = process.env.PUSH_SEND_SECRET || process.env.SCANNER_TRIGGER_SECRET;
  if (secret) {
    const h =
      event.headers["x-push-secret"] ||
      event.headers["X-Push-Secret"] ||
      "";
    if (h !== secret) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
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
  const title = body.title || "SOHELATOR";
  const text = body.body || "Alert";
  const result = await sendPushToAll({ title, body: text, data: body.data || {} });
  return { statusCode: 200, headers, body: JSON.stringify(result) };
};
