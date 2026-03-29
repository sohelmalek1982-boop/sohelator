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
  const [jobHealth, clock] = await Promise.all([
    getJobHealth(),
    tradierClock(),
  ]);
  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      jobHealth,
      marketClock: clock,
      at: Date.now(),
    }),
  };
};
