const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

async function claudeLearn(note) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
  if (!key) return "Add ANTHROPIC_API_KEY for learning notes.";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 500,
      messages: [
        {
          role: "user",
          content:
            "Alert said " +
            note.setupType +
            " on " +
            note.ticker +
            " with score " +
            note.score +
            ". Trader held " +
            note.holdDays +
            " days, result: " +
            note.pnlPct +
            "%. What worked, what did not, what should we watch for next time? Be concise (max 5 sentences).",
        },
      ],
    }),
  });
  const data = await res.json();
  return (
    data.content?.[0]?.text ||
    data.error?.message ||
    "No learning output."
  );
}

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const learnStore = getStore("learnings");
  const alertsStore = getStore("alerts");

  if (event.httpMethod === "GET") {
    const items = [];
    try {
      for await (const page of learnStore.list({
        prefix: "learning_",
        paginate: true,
      })) {
        for (const b of page.blobs || []) {
          try {
            const row = await learnStore.get(b.key, { type: "json" });
            if (row) items.push(row);
          } catch {
            /* skip */
          }
        }
      }
    } catch (e) {
      console.error(e);
    }
    items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ learnings: items.slice(0, 30) }),
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "Bad method" }) };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const {
    ticker,
    entrySignal = "",
    entryScore = 0,
    pnlPct = 0,
    holdDays = 0,
    optionType = "",
  } = body;

  if (!ticker) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "ticker required" }),
    };
  }

  let matchedKey = null;
  let matched = null;
  const candidates = [];
  try {
    for await (const page of alertsStore.list({
      prefix: "alert_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        try {
          const row = await alertsStore.get(b.key, { type: "json" });
          if (row && row.ticker === ticker.toUpperCase()) {
            candidates.push({ key: b.key, row });
          }
        } catch {
          /* skip */
        }
      }
    }
  } catch (e) {
    console.error(e);
  }

  candidates.sort((a, b) => (b.row.timestamp || 0) - (a.row.timestamp || 0));
  if (candidates.length) {
    matchedKey = candidates[0].key;
    matched = candidates[0].row;
  }

  const outcome = {
    pnlPct,
    holdDays,
    optionType,
    closedAt: Date.now(),
  };

  if (matchedKey && matched) {
    const updated = { ...matched, outcome };
    await alertsStore.setJSON(matchedKey, updated);
  }

  const setupType = matched?.setupType || entrySignal || "UNKNOWN";
  const score = matched?.score ?? entryScore;

  const feedback = await claudeLearn({
    ticker: ticker.toUpperCase(),
    setupType,
    score,
    holdDays,
    pnlPct,
  });

  const learningRow = {
    ticker: ticker.toUpperCase(),
    entrySignal: setupType,
    entryScore: score,
    pnlPct,
    holdDays,
    optionType,
    feedback,
    timestamp: Date.now(),
  };

  await learnStore.setJSON("learning_" + Date.now(), learningRow);

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({ ok: true, feedback, learningRow }),
  };
};
