/**
 * BRIEF / LEARNING tab — `learning-YYYY-MM-DD` and `eod-review-YYYY-MM-DD` in sohelator-learning.
 */

const { getStore } = require("@netlify/blobs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const LEARNING_KEY_RE = /^learning-(\d{4}-\d{2}-\d{2})$/;
const EOD_RE = /^eod-review-(\d{4}-\d{2}-\d{2})$/;

function ymdEtNow() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function rowFromLearningKey(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = String(key).match(LEARNING_KEY_RE);
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

function rowFromEodReviewKey(key, raw) {
  if (!raw || typeof raw !== "object") return null;
  const m = String(key).match(EOD_RE);
  const date = m ? m[1] : "";
  const parsed = raw.parsed || {};
  const sum = raw.sessionSummary || {};
  const ft = String(raw.fullText || "");
  const reviewPlain = ft.split("{")[0].trim();
  return {
    date,
    kind: "eod",
    sessionGrade: parsed.sessionGrade,
    keyLearning: parsed.keyLearning,
    alertQuality: parsed.alertQuality,
    signalAccuracy: parsed.signalAccuracy,
    tomorrowFocus: parsed.tomorrowFocus,
    eodReviewPlain: reviewPlain,
    wins: sum.wins,
    losses: sum.losses,
    totalPnlPct: sum.totalPnlPct,
    parsed,
  };
}

function mergeLearningEod(date, learningRaw, eodRaw) {
  const lr = learningRaw ? rowFromLearningKey(`learning-${date}`, learningRaw) : null;
  const er = eodRaw ? rowFromEodReviewKey(`eod-review-${date}`, eodRaw) : null;
  if (!lr && !er) return null;
  const out = lr
    ? { ...lr }
    : {
        date,
        sessionGrade: null,
        keyLearning: null,
        performanceReview: null,
        cheapGrokAudit: null,
        filterAssessment: null,
        tomorrowInstructions: null,
        parameterSuggestions: null,
        parameterMergeDiff: null,
        wins: null,
        losses: null,
        totalPnlPct: null,
      };
  if (er) {
    if (er.sessionGrade != null && er.sessionGrade !== "")
      out.sessionGrade = er.sessionGrade;
    if (er.keyLearning != null && er.keyLearning !== "")
      out.keyLearning = er.keyLearning;
    out.alertQuality = er.alertQuality;
    out.signalAccuracy = er.signalAccuracy;
    out.tomorrowFocus = er.tomorrowFocus;
    out.eodReviewPlain = er.eodReviewPlain;
    out.hasEodReview = true;
    if (er.wins != null) out.wins = er.wins;
    if (er.losses != null) out.losses = er.losses;
    if (er.totalPnlPct != null && String(er.totalPnlPct) !== "")
      out.totalPnlPct = er.totalPnlPct;
  }
  return out;
}

async function listBlobKeys(store, prefix) {
  const keys = [];
  for await (const page of store.list({ prefix, paginate: true })) {
    for (const b of page.blobs || []) {
      if (b.key) keys.push(b.key);
    }
  }
  return keys;
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
        todayEodReview: null,
        todayEt: ymdEtNow(),
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
    const [learningKeys, eodKeys] = await Promise.all([
      listBlobKeys(store, "learning-"),
      listBlobKeys(store, "eod-review-"),
    ]);
    const dateSet = new Set();
    for (const k of learningKeys) {
      const m = k.match(LEARNING_KEY_RE);
      if (m) dateSet.add(m[1]);
    }
    for (const k of eodKeys) {
      const m = k.match(EOD_RE);
      if (m) dateSet.add(m[1]);
    }
    const dates = Array.from(dateSet).sort().reverse();

    const entries = [];
    for (const date of dates) {
      let learningRaw = null;
      let eodRaw = null;
      try {
        learningRaw = await store.get(`learning-${date}`, { type: "json" });
      } catch {
        /* skip */
      }
      try {
        eodRaw = await store.get(`eod-review-${date}`, { type: "json" });
      } catch {
        /* skip */
      }
      const row = mergeLearningEod(date, learningRaw, eodRaw);
      if (row) entries.push(row);
    }

    const todayEt = ymdEtNow();
    let todayEodReview = null;
    try {
      const te = await store.get(`eod-review-${todayEt}`, { type: "json" });
      if (te) todayEodReview = rowFromEodReviewKey(`eod-review-${todayEt}`, te);
    } catch {
      /* ignore */
    }

    const latest = entries.length ? entries[0] : null;
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        entries,
        latest,
        todayEodReview,
        todayEt,
      }),
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
