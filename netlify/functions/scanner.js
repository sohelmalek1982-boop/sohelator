const { schedule } = require("@netlify/functions");
const { runScan } = require("./scanner-core");
const { recordJobError } = require("./lib/jobHealth");

async function handler() {
  try {
    const result = await runScan();
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    console.error(e);
    await recordJobError("scanner", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  }
}

exports.handler = schedule("*/5 9-16 * * 1-5", handler);
