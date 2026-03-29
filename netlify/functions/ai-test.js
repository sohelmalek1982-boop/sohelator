const fetch = require("node-fetch");
const { withSohelContext, parseClaudeResponse } = require("./lib/sohelContext");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

const SCENARIOS = [
  {
    id: 1,
    name: "CHOP",
    user: `TEST 1 — CHOP
Facts: ADX 14, MACD flat, RSI 50, volume 0.9x average, price inside value area. No clear trend.
In 4 sentences max: what should Sohel do?`,
  },
  {
    id: 2,
    name: "PERFECT_BULL",
    user: `TEST 2 — PERFECT BULL
Facts: ADX 32 rising, MACD histogram expanding for 3 bars, RSI 57, price above VWAP, volume 2.8x average, just broke above pivot R1 at $500.
In 4 sentences max: specific action including a call strike if you recommend buying.`,
  },
  {
    id: 3,
    name: "REVERSAL_WARNING",
    user: `TEST 3 — REVERSAL WARNING
Facts: RSI 74, MACD histogram shrinking vs prior bars, price just lost VWAP on a 5m close, still in a longer-term uptrend.
In 4 sentences max: exit, hold, or tighten stop?`,
  },
  {
    id: 4,
    name: "APPROACHING_RESISTANCE",
    user: `TEST 4 — APPROACHING RESISTANCE
Facts: Price 0.3% below major resistance $520, mixed signals (MACD positive but volume light), ADX 24.
In 4 sentences max: wait for breakout or fade?`,
  },
  {
    id: 5,
    name: "BEHAVIORAL",
    user: `TEST 5 — BEHAVIORAL
Facts: Setup is valid (8/10), Sohel is already +45% on the option. Memory: he historically exits winners too early (8 times logged).
In 4 sentences max: what should he do and reference the behavioral pattern.`,
  },
];

async function runScenario(key, model, sc) {
  const system = withSohelContext(
    `You are answering a controlled test scenario. Follow Sohel's rules (options only, chop = stand aside, stops -40%, targets +80–150%). Be direct.`,
    ""
  );
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 600,
      system,
      messages: [{ role: "user", content: sc.user }],
    }),
  });
  const data = await res.json();
  const text =
    data.content?.[0]?.text ||
    data.error?.message ||
    "No response.";
  return {
    id: sc.id,
    name: sc.name,
    raw: String(text).trim(),
    parsed: parseClaudeResponse(text),
    error: data.error || null,
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
      body: JSON.stringify({ error: "GET only" }),
    };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL_CHAT || "claude-sonnet-4-20250514";

  if (!key) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "ANTHROPIC_API_KEY not set",
        scenarios: SCENARIOS.map((s) => ({ id: s.id, name: s.name, user: s.user })),
      }),
    };
  }

  const results = [];
  for (const sc of SCENARIOS) {
    try {
      results.push(await runScenario(key, model, sc));
    } catch (e) {
      results.push({
        id: sc.id,
        name: sc.name,
        error: String(e.message || e),
        raw: "",
        parsed: null,
      });
    }
  }

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      ok: true,
      model,
      at: Date.now(),
      tests: results,
    }),
  };
};
