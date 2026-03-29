const { recordTrade } = require("./lib/memory");

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
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  if (!body.ticker) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "ticker required" }),
    };
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
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, trade }),
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message || "record failed" }),
    };
  }
};
