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

// UTC — cover US RTH (~9:30–16:00 ET) year-round (was 9–16 UTC ≈ ends ~noon ET).
exports.handler = schedule("*/5 13-21 * * 1-5", handler);
