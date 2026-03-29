const { getMemoryContext } = require("./lib/memory");

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

  const ticker = event.queryStringParameters?.ticker || null;
  try {
    const memory = await getMemoryContext(ticker || undefined);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(memory),
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message || "memory load failed" }),
    };
  }
};
