/**
 * Extra morning pipeline before the bell: runs 9:25 + 9:55 logic off the normal ET windows.
 * Schedule is UTC (Netlify): 08:00 Mon–Fri ≈ 3:00 AM America/New_York in standard time;
 * during EDT it runs ~4:00 AM local. Adjust cron if you need a different slot.
 *
 * Requires SCAN_FORCE_SECRET (same as manual POST /api/scan-925) and a public site URL.
 */
const fetch = require("node-fetch");
const { schedule } = require("@netlify/functions");
const { recordJobOk, recordJobError } = require("./lib/jobHealth");

function siteBaseUrl() {
  const u =
    process.env.URL ||
    process.env.DEPLOY_PRIME_URL ||
    process.env.NETLIFY_SITE_URL ||
    "";
  return String(u).replace(/\/$/, "");
}

async function runChain() {
  const base = siteBaseUrl();
  const secret = process.env.SCAN_FORCE_SECRET;
  if (!base || !secret) {
    const msg =
      "scan-3am: set URL (Netlify sets URL / DEPLOY_PRIME_URL) and SCAN_FORCE_SECRET";
    console.error(msg);
    await recordJobError("scan-3am", msg);
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: msg }),
    };
  }

  const opts = {
    method: "POST",
    headers: { "X-Scan-Force": secret },
  };

  const r1 = await fetch(base + "/api/scan-925", opts);
  const t1 = await r1.text();
  let j1;
  try {
    j1 = JSON.parse(t1);
  } catch {
    j1 = { raw: t1.slice(0, 500) };
  }

  const r2 = await fetch(base + "/api/scan-955", opts);
  const t2 = await r2.text();
  let j2;
  try {
    j2 = JSON.parse(t2);
  } catch {
    j2 = { raw: t2.slice(0, 500) };
  }

  const ok = r1.ok && r2.ok && !j1.skipped && !j2.skipped;
  try {
    await recordJobOk("scan-3am", {
      scan925Status: r1.status,
      scan955Status: r2.status,
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
      scan925: { status: r1.status, body: j1 },
      scan955: { status: r2.status, body: j2 },
    }),
  };
}

exports.handler = schedule("0 8 * * 1-5", runChain);
