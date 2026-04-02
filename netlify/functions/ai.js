const fetch = require("node-fetch");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { getMemoryContext } = require("./lib/memory.cjs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, headers, body: JSON.stringify({ error: "POST only" }) };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const key = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL_CHAT || "claude-sonnet-4-20250514";

  const ticker = (body.ticker || "TICKER").toUpperCase();
  const ind = body.indicators || {};
  const priceFromBody =
    body.price != null ? parseFloat(body.price) : NaN;

  const userBlock = `Current indicators for ${ticker}:
ADX: ${ind.adx} (slope vs 6 bars ago: ${ind.adxSlope})
MACD Histogram: ${ind.macdH} (slope: ${ind.macdSlope})
RSI: ${ind.rsi}
VWAP Distance: ${ind.vwapDist}%
BB %B: ${ind.bbPctB}
StochRSI K: ${ind.stochK} D: ${ind.stochD}
ATR: ${ind.atr} (${ind.atrPct}% of price)
Current stage: ${ind.stage}
Above VWAP: ${ind.aboveVWAP}

Give me:
1. Overall verdict — exactly one of: BULLS IN CONTROL | BEARS IN CONTROL | MIXED | CHOP
2. Two or three sentences explaining what this all means for my current position or entry (options 1–3 day holds)
3. The single most important thing to watch right now

Respond ONLY with valid JSON (no markdown), shape:
{"verdict":"BULLS IN CONTROL","summary":"...","watch":"..."}`;

  const systemPrompt = `You are interpreting trading indicators for Sohel's options dashboard. He trades options with 1–3 day holds. Give him a plain English overall reading in 2–3 sentences in the summary field. Tell him what the indicators collectively mean for his trade right now. Be direct — should he hold, enter, or exit? Never use jargon without explaining it.

The user message contains live indicator values. Respond ONLY with valid JSON (no markdown), shape:
{"verdict":"BULLS IN CONTROL","summary":"...","watch":"..."}`;

  if (!key) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        fallback: true,
        verdict: "MIXED",
        summary:
          "AI is offline (no ANTHROPIC_API_KEY on the server). Use the indicator cards below for the full read.",
        watch: "Deploy the key on Netlify, then reload.",
      }),
    };
  }

  try {
    let master = null;
    let memory = null;
    try {
      master = await getMasterAnalysis(ticker);
    } catch (e) {
      console.error("ai getMasterAnalysis", e);
    }
    try {
      memory = await getMemoryContext(ticker);
    } catch (e) {
      console.error("ai getMemoryContext", e);
    }
    let price = 0;
    if (isFinite(priceFromBody) && !isNaN(priceFromBody)) {
      price = priceFromBody;
    } else if (master?.price != null && isFinite(master.price)) {
      price = master.price;
    }
    const extra = buildTradingContext(master, ticker, price, memory);
    const system = withSohelContext(systemPrompt, extra);

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
        messages: [{ role: "user", content: userBlock }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || "";
    let parsed = null;
    try {
      const m = text.match(/\{[\s\S]*\}/);
      parsed = m ? JSON.parse(m[0]) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed.verdict !== "string") {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: true,
          verdict: "MIXED",
          summary: text.slice(0, 400) || "No structured reply.",
          watch: "Re-read the indicator cards for specifics.",
          raw: true,
        }),
      };
    }
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        verdict: String(parsed.verdict).toUpperCase(),
        summary: String(parsed.summary || ""),
        watch: String(parsed.watch || ""),
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        fallback: true,
        verdict: "MIXED",
        summary: "Could not reach AI. Indicator cards below still update live.",
        watch: String(e.message || "Retry later"),
      }),
    };
  }
};
