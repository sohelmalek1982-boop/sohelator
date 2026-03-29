/**
 * In-repo "TradingAgents-style" brief: one structured Claude pass over master + memory.
 * Cached per symbol per NY calendar day in Netlify Blobs.
 */
const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { getMemoryContext } = require("./lib/memory");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function nyDateStr() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function cacheKey(symbol, dateStr) {
  return "research_brief_" + symbol.toUpperCase() + "_" + dateStr;
}

function compactPack(master, memory) {
  if (!master) return { error: "no_master" };
  const m = master;
  return {
    symbol: m.symbol,
    price: m.price,
    confidence: m.confidence,
    tradingBias: m.tradingBias,
    summary: m.summary,
    gex: m.gex
      ? {
          regime: m.gex.gexRegime,
          note: String(m.gex.interpretation || "").slice(0, 400),
        }
      : null,
    flow: m.optionsFlow
      ? {
          bias: m.optionsFlow.smartMoneyBias,
          summary: String(m.optionsFlow.flowSummary || "").slice(0, 300),
        }
      : null,
    levels: m.levels
      ? {
          resist: m.levels.nearestResistance,
          support: m.levels.nearestSupport,
        }
      : null,
    sector: m.sector
      ? {
          tailwind: m.sector.tailwind,
          headwind: m.sector.headwind,
        }
      : null,
    momentum: m.momentum
      ? { bias: m.momentum.momentumBias, atrPct: m.momentum.atrPct }
      : null,
    regime: m.regime?.primary || null,
    skipEarnings: m.skipDueToEarnings,
    memoryLines: (memory?.insights || []).slice(0, 6),
  };
}

function parseJsonFromText(text) {
  const raw = String(text || "").trim();
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    return JSON.parse(m[0]);
  } catch {
    return null;
  }
}

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "POST only" }),
    };
  }

  let body = {};
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const symbol = String(body.symbol || "")
    .toUpperCase()
    .replace(/[^A-Z0-9.]/g, "")
    .slice(0, 8);
  const refresh = body.refresh === true;
  const dateStr = nyDateStr();

  if (!symbol) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "symbol required" }),
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL_RESEARCH || "claude-haiku-4-5-20251001";

  const store = getStore({
    name: "trading-memory",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });

  const ck = cacheKey(symbol, dateStr);
  if (!refresh && apiKey) {
    try {
      const cached = await store.get(ck, { type: "json" });
      if (
        cached &&
        cached.brief &&
        cached.nyDate === dateStr &&
        cached.symbol === symbol
      ) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            cached: true,
            symbol,
            nyDate: dateStr,
            model: cached.model,
            generatedAt: cached.generatedAt,
            brief: cached.brief,
          }),
        };
      }
    } catch (e) {
      console.error("research-brief cache read", e);
    }
  }

  if (!apiKey) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "ANTHROPIC_API_KEY not configured",
        symbol,
      }),
    };
  }

  let master = null;
  let memory = null;
  try {
    master = await getMasterAnalysis(symbol);
  } catch (e) {
    console.error("research-brief master", e);
  }
  try {
    memory = await getMemoryContext(symbol);
  } catch (e) {
    console.error("research-brief memory", e);
  }

  if (!master) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        error: "Could not load tape context for " + symbol + ". Try again after GO.",
        symbol,
      }),
    };
  }

  const price = master.price != null ? Number(master.price) : 0;
  const pack = compactPack(master, memory);
  const extra = buildTradingContext(master, symbol, price, memory || { insights: [] });

  const userContent = `You are synthesizing a single research brief for an options swing trader (1–3 day holds).

DATA PACK (JSON — treat as ground truth; do not invent prices):
${JSON.stringify(pack)}

Task: Act like a small trading desk — technical read, context, explicit bull case, explicit bear case, key risk, then a one-line verdict.

Respond ONLY with valid JSON (no markdown), exactly this shape:
{"technical":"2-4 sentences: trend, key levels, momentum vs chop","context":"2-3 sentences: sector/flow/GEX tension in plain English","bullCase":"2-3 sentences","bearCase":"2-3 sentences","risk":"1-3 sentences: what would invalidate the trade or force a stand-down","verdict":"One line starting with WAIT | LEAN LONG | LEAN SHORT | NO TRADE — then why"}`;

  const system = withSohelContext(
    `You output ONLY valid JSON with keys: technical, context, bullCase, bearCase, risk, verdict. No markdown. Be specific to the symbol and data. If earnings or skip flags are true, say NO TRADE or WAIT clearly.`,
    extra
  );

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        messages: [{ role: "user", content: userContent }],
      }),
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || data.error?.message || "";
    const parsed = parseJsonFromText(text);
    if (
      !parsed ||
      typeof parsed.verdict !== "string" ||
      typeof parsed.technical !== "string"
    ) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ok: false,
          error: "Could not parse AI response",
          symbol,
          raw: String(text).slice(0, 500),
        }),
      };
    }

    const brief = {
      technical: String(parsed.technical || ""),
      context: String(parsed.context || ""),
      bullCase: String(parsed.bullCase || ""),
      bearCase: String(parsed.bearCase || ""),
      risk: String(parsed.risk || ""),
      verdict: String(parsed.verdict || ""),
    };

    const generatedAt = Date.now();
    try {
      await store.setJSON(ck, {
        symbol,
        nyDate: dateStr,
        model,
        generatedAt,
        brief,
      });
    } catch (e) {
      console.error("research-brief cache write", e);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        cached: false,
        symbol,
        nyDate: dateStr,
        model,
        generatedAt,
        brief,
      }),
    };
  } catch (e) {
    console.error("research-brief", e);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(e.message || e),
        symbol,
      }),
    };
  }
};
