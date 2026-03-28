const { schedule } = require("@netlify/functions");
const { runScan } = require("./scanner-core");

async function handler() {
  try {
    const result = await runScan();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error(e);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}

exports.handler = schedule("*/5 9-16 * * 1-5", handler);
