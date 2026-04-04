/**
 * Extra morning pipeline before the bell: runs 9:25 + 9:55 logic off the normal ET windows.
 * Schedule is UTC (Netlify): 08:00 Mon–Fri ≈ 3:00 AM America/New_York in standard time;
 * during EDT it runs ~4:00 AM local. Adjust cron if you need a different slot.
 *
 * Calls scan-925 / scan-955 in-process (no public URL, no SCAN_FORCE_SECRET required).
 * Force is applied via lib/scanForce.js `_sohelScan3amPipeline` (in-process only).
 */
const { schedule } = require("@netlify/functions");
const { recordJobOk, recordJobError } = require("./lib/jobHealth");
const { run925ForPipeline } = require("./scan-925");
const { run955ForPipeline } = require("./scan-955");

function parseJsonBody(res) {
  if (!res || res.body == null) return {};
  try {
    return JSON.parse(res.body);
  } catch {
    return { raw: String(res.body).slice(0, 500) };
  }
}

const PIPELINE_EVENT = {
  httpMethod: "POST",
  _sohelScan3amPipeline: true,
};

async function runChain() {
  let r1;
  let r2;
  let j1;
  let j2;
  try {
    r1 = await run925ForPipeline(PIPELINE_EVENT);
    j1 = parseJsonBody(r1);
    r2 = await run955ForPipeline(PIPELINE_EVENT);
    j2 = parseJsonBody(r2);
  } catch (e) {
    const msg = String(e?.message || e);
    console.error("scan-3am", msg);
    await recordJobError("scan-3am", msg);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: msg }),
    };
  }

  const ok =
    r1.statusCode === 200 &&
    r2.statusCode === 200 &&
    !j1.skipped &&
    !j2.skipped;

  try {
    await recordJobOk("scan-3am", {
      scan925Status: r1.statusCode,
      scan955Status: r2.statusCode,
      skipped925: !!j1.skipped,
      skipped955: !!j2.skipped,
    });
  } catch (e) {
    console.error("recordJobOk scan-3am", e);
  }

  return {
    statusCode: ok ? 200 : 502,
    body: JSON.stringify({
      ok,
      scan925: { status: r1.statusCode, body: j1 },
      scan955: { status: r2.statusCode, body: j2 },
    }),
  };
}

exports.handler = schedule("0 8 * * 1-5", runChain);
