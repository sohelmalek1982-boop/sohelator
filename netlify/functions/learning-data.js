/**
 * BRIEF / LEARNING tab — `learning-YYYY-MM-DD` blobs in sohelator-learning (scan-eod expensive Grok debrief).
 */

const { getStore } = require("@netlify/blobs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const KEY_RE = /^learning-(\d{4}-\d{2}-\d{2})$/;

function rowFromBlob(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = String(key).match(KEY_RE);
  const date = m ? m[1] : raw.summary?.date || "";
  const sum = raw.summary || {};
  return {
    date,
    sessionGrade: raw.sessionGrade,
    keyLearning: raw.keyLearning,
    performanceReview: raw.performanceReview,
    cheapGrokAudit: raw.cheapGrokAudit,
    filterAssessment: raw.filterAssessment,
    tomorrowInstructions: raw.tomorrowInstructions,
    parameterSuggestions: raw.parameterSuggestions,
    parameterMergeDiff: raw.parameterMergeDiff,
    wins: sum.wins,
    losses: sum.losses,
    totalPnlPct: sum.totalPnlPct,
  };
}

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: "GET only" }),
    };
  }

  if (!process.env.NETLIFY_SITE_ID || !process.env.NETLIFY_TOKEN) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        entries: [],
        latest: null,
        note: "NETLIFY_SITE_ID / NETLIFY_TOKEN not set",
      }),
    };
  }

  try {
    const store = getStore({
      name: "sohelator-learning",
      siteID: process.env.NETLIFY_SITE_ID,
      token: process.env.NETLIFY_TOKEN,
    });
    const keys = [];
    for await (const page of store.list({
      prefix: "learning-",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        if (b.key && KEY_RE.test(b.key)) keys.push(b.key);
      }
    }
    keys.sort();
    const sortedDesc = keys.slice().reverse();
    const entries = [];
    for (const key of sortedDesc) {
      try {
        const raw = await store.get(key, { type: "json" });
        const row = rowFromBlob(key, raw);
        if (row) entries.push(row);
      } catch {
        /* skip */
      }
    }
    const latest = entries.length ? entries[0] : null;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, entries, latest }),
    };
  } catch (e) {
    console.error("learning-data", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(e?.message || e) }),
    };
  }
};
