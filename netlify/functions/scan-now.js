const { runScan } = require("./scanner-core");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Scanner-Secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

exports.handler = async (event) => {
  console.log("scan-now triggered", new Date().toISOString());
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }
  const secret = process.env.SCANNER_TRIGGER_SECRET;
  if (secret) {
    const h =
      event.headers["x-scanner-secret"] ||
      event.headers["X-Scanner-Secret"] ||
      "";
    if (h !== secret) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: "Unauthorized" }),
      };
    }
  }
  try {
    const result = await runScan();
    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message }),
    };
  }
};
