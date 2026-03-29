const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { sendPushToAll } = require("./lib/pushAll");
const {
  withSohelContext,
  buildTradingContext,
  parseClaudeResponse,
  normalizeIgnitionForContext,
} = require("./lib/sohelContext");
const { calculateRegime } = require("./lib/marketRegime");
const { getMemoryContext, recordAlertSnapshot } = require("./lib/memory");
const { predictSetup, calculateRetestEntry } = require("./lib/predictive");
const { calculateUrgency, buildTelegramMessage } = require("./lib/urgency");
const { recommendSize } = require("./lib/sizing");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { analyzeVolume } = require("./lib/volumeAnalysis");
const { calculateIgnition } = require("./lib/ignition");
const { isEquitySessionDay } = require("./lib/marketCalendar");
const { recordJobOk } = require("./lib/jobHealth");

const BASE_WATCH = [
  "NVDA", "TSLA", "SPY", "QQQ", "AAPL", "AMD", "MSFT", "META", "GOOGL",
  "AMZN", "NFLX", "COIN", "MSTR", "PLTR", "ARM", "SMCI", "MU", "AVGO",
  "TSM", "UBER",
];

const TICKER_BLOCK = new Set([
  "THE", "AND", "FOR", "ARE", "BUT", "NOT", "YOU", "ALL", "CAN", "HER",
  "WAS", "ONE", "OUR", "OUT", "DAY", "GET", "HAS", "HIM", "HIS", "HOW",
  "ITS", "LET", "PUT", "SAY", "SHE", "TOO", "USE", "MAY", "NEW", "NOW",
  "SEE", "TWO", "WHO", "BOY", "DID", "EPS", "IPO", "ETF", "USA", "NYSE",
  "CPI", "GDP", "Fed", "SEC",
]);

function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  const sl = closes.slice(-p - 1);
  let g = 0,
    l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    d > 0 ? (g += d) : (l -= d);
  }
  const ag = g / p,
    al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 35) return { hist: 0 };
  const k12 = 2 / 13,
    k26 = 2 / 27,
    k9 = 2 / 10;
  let e12 = closes[0],
    e26 = closes[0];
  const ml = [];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) ml.push(e12 - e26);
  }
  if (!ml.length) return { hist: 0 };
  let sig = ml[0];
  for (let i = 1; i < ml.length; i++) sig = ml[i] * k9 + sig * (1 - k9);
  return { hist: ml[ml.length - 1] - sig };
}

function calcADX(candles, p = 14) {
  if (candles.length < p + 2) return 15;
  const sl = candles.slice(-(p + 1));
  let pdm = 0,
    ndm = 0,
    tr = 0;
  for (let i = 1; i < sl.length; i++) {
    const h = sl[i].high,
      l = sl[i].low,
      ph = sl[i - 1].high,
      pl = sl[i - 1].low,
      pc = sl[i - 1].close;
    const um = h - ph,
      dm = pl - l;
    pdm += um > dm && um > 0 ? um : 0;
    ndm += dm > um && dm > 0 ? dm : 0;
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (!tr) return 15;
  const pdi = (pdm / tr) * 100,
    ndi = (ndm / tr) * 100,
    s = pdi + ndi;
  return s > 0 ? (Math.abs(pdi - ndi) / s) * 100 : 15;
}

function emaLast(closes, period) {
  if (!closes.length) return 0;
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

function bollingerPctB(closes, period = 20) {
  if (closes.length < period) return 0.5;
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const varc =
    slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
  const sd = Math.sqrt(varc);
  const upper = mean + 2 * sd;
  const lower = mean - 2 * sd;
  const last = closes[closes.length - 1];
  const w = upper - lower || 1e-9;
  return (last - lower) / w;
}

function vwapDistPct(candles, price) {
  if (!candles.length || !price) return 0;
  const today = new Date().toDateString();
  let pv = 0,
    vv = 0;
  for (const c of candles) {
    const d = new Date(c.time).toDateString();
    if (d !== today) continue;
    const tp = (c.high + c.low + c.close) / 3;
    pv += tp * c.vol;
    vv += c.vol;
  }
  if (vv === 0) {
    const c = candles[candles.length - 1];
    const tp = (c.high + c.low + c.close) / 3;
    return ((price - tp) / tp) * 100;
  }
  const vwap = pv / vv;
  return ((price - vwap) / vwap) * 100;
}

function threeSameDir(closes) {
  if (closes.length < 4) return false;
  const a = closes[closes.length - 1] - closes[closes.length - 2];
  const b = closes[closes.length - 2] - closes[closes.length - 3];
  const c = closes[closes.length - 3] - closes[closes.length - 4];
  if (a > 0 && b > 0 && c > 0) return true;
  if (a < 0 && b < 0 && c < 0) return true;
  return false;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradier(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  ).toString();
  const url = tradierBase() + path + (qs ? "?" + qs : "");
  const res = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function fetchUnderlyingPnlMap() {
  const acc = process.env.TRADIER_ACCOUNT_ID;
  if (!acc) return {};
  try {
    const j = await tradier("/v1/accounts/" + acc + "/positions", {});
    const map = {};
    for (const p of normList(j.positions?.position)) {
      const u = String(p.underlying_symbol || "").toUpperCase().trim();
      if (!u) continue;
      const cost = parseFloat(p.cost_basis || 0);
      const mv = parseFloat(p.market_value || 0);
      const pl = cost ? ((mv - cost) / Math.abs(cost)) * 100 : 0;
      if (map[u] == null || pl < map[u]) map[u] = pl;
    }
    return map;
  } catch {
    return {};
  }
}

function detectIntradayStage(ctx, regimeThresholds = {}) {
  const {
    adxVal,
    adxSlope,
    macdHist,
    macdSlope,
    rsi14,
    vwapDist,
    bbB,
    bull,
    bear,
    breakout,
    reversal,
    rsi2,
    ema8,
    ema21,
    bullOk,
    bearOk,
  } = ctx;
  const rsiNum = Number(rsi14);
  const aboveVWAP = vwapDist > 0;
  const macdPos = macdHist > 0;
  const minAdxLine =
    regimeThresholds.minADX != null ? regimeThresholds.minADX : 20;

  if (adxVal < minAdxLine) {
    return {
      stage: "chop",
      stageLabel: "CHOP",
      stageEmoji: "⚠️",
      action: "NO EDGE",
    };
  }

  if (reversal) {
    return {
      stage: "reversal",
      stageLabel: "REVERSAL",
      stageEmoji: "🚨",
      action: "SMALL SIZE",
    };
  }

  if (breakout && macdPos && aboveVWAP) {
    return {
      stage: "bull",
      stageLabel: "BULL CONFIRMED",
      stageEmoji: "✅",
      action: "BUY CALLS NOW",
    };
  }
  if (breakout && !macdPos && !aboveVWAP) {
    return {
      stage: "bear",
      stageLabel: "BEAR CONFIRMED",
      stageEmoji: "🔴",
      action: "BUY PUTS NOW",
    };
  }

  if (
    bullOk &&
    macdPos &&
    aboveVWAP &&
    rsiNum >= 50 &&
    rsiNum <= 70
  ) {
    return {
      stage: "bull",
      stageLabel: "BULL CONFIRMED",
      stageEmoji: "✅",
      action: "BUY CALLS NOW",
    };
  }
  if (
    bearOk &&
    !macdPos &&
    !aboveVWAP &&
    rsiNum >= 30 &&
    rsiNum <= 50
  ) {
    return {
      stage: "bear",
      stageLabel: "BEAR CONFIRMED",
      stageEmoji: "🔴",
      action: "BUY PUTS NOW",
    };
  }

  if (bull >= 55 && bull < 75 && macdPos) {
    return {
      stage: "setup_bull",
      stageLabel: "BULL SETUP",
      stageEmoji: "🔍",
      action: "WATCH — CONFIRM",
    };
  }
  if (bear >= 55 && bear < 75 && !macdPos) {
    return {
      stage: "setup_bear",
      stageLabel: "BEAR SETUP",
      stageEmoji: "🔍",
      action: "WATCH — CONFIRM",
    };
  }

  const fading =
    (macdPos && !aboveVWAP && (adxSlope < 0 || macdSlope < 0)) ||
    (bullOk && !aboveVWAP);
  if (fading) {
    return {
      stage: "fading",
      stageLabel: "FADING",
      stageEmoji: "⚡",
      action: "SKIP / CUT",
    };
  }

  return {
    stage: "chop",
    stageLabel: "NO EDGE",
    stageEmoji: "⚠️",
    action: "SKIP",
  };
}

function shouldSendStageAlert(stage, ticker, pnlMap) {
  if (stage === "chop" || stage === "reversal") return false;
  if (stage === "fading") {
    const p = pnlMap[ticker];
    return p != null && p <= -35;
  }
  return ["bull", "bear", "setup_bull", "setup_bear"].includes(stage);
}

function buildMemorySnippet(memory, ticker) {
  if (!memory) return "";
  const ins = (memory.insights || []).slice(0, 5).join(" | ");
  const ts = memory.allTickerStats?.find((t) => t.ticker === ticker);
  const tline = ts
    ? `${ticker}: ${ts.winRate}% WR, ${ts.totalTrades} trades`
    : `${ticker}: no stats yet`;
  const bp = [...(memory.allPatternStats || [])].sort(
    (a, b) => (b.winRate || 0) - (a.winRate || 0)
  )[0];
  let s =
    "SOHEL'S TRADING MEMORY:\n" +
    (ins || "Building performance history.") +
    "\n" +
    tline +
    "\nBest setup type: " +
    (bp ? `${bp.stage} (${bp.winRate}%)` : "insufficient data");
  if ((memory.behavioralStats?.exitTooEarlyCount || 0) > 2) {
    s += "\nNOTE: tendency to exit winners early — hold if setup intact.";
  }
  if ((memory.behavioralStats?.heldLoserCount || 0) > 2) {
    s += "\nNOTE: tendency to hold losers — enforce -40% cut.";
  }
  return s;
}

async function fetchRegimeMarketData() {
  const qd = await tradier("/v1/markets/quotes", {
    symbols: "SPY,QQQ,VIX,$VIX",
    greeks: "false",
  });
  const bySym = {};
  for (const q of normList(qd.quotes?.quote)) {
    if (q.symbol) bySym[q.symbol] = q;
  }
  const spy = bySym.SPY;
  const qqq = bySym.QQQ;
  const vx = bySym.VIX || bySym.$VIX;
  const spyChange = parseFloat(
    spy?.change_percentage ?? spy?.percent_change ?? 0
  );
  const qqqChange = parseFloat(
    qqq?.change_percentage ?? qqq?.percent_change ?? 0
  );
  const vix = parseFloat(vx?.last ?? vx?.close ?? 18) || 18;
  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);
  const ts = await tradier("/v1/markets/timesales", {
    symbol: "SPY",
    interval: "5min",
    start: ymd(start),
    end: ymd(end),
    session_filter: "open",
  });
  const raw = normList(ts.series?.data);
  const candles = raw
    .map((c) => ({
      time: c.time || c.timestamp,
      open: parseFloat(c.open),
      high: parseFloat(c.high),
      low: parseFloat(c.low),
      close: parseFloat(c.close),
      vol: parseFloat(c.volume || c.volum || 0),
    }))
    .filter((c) => !isNaN(c.close));
  let spyAdx = 20;
  let spyRsi = 50;
  let spyVwapDist = 0;
  if (candles.length >= 20) {
    const closes = candles.map((c) => c.close);
    const adxCandles = candles.map((c) => ({
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    spyAdx = calcADX(adxCandles, 14);
    spyRsi = calcRSI(closes, 14);
    const spyLast = parseFloat(spy?.last ?? closes[closes.length - 1] ?? 0);
    spyVwapDist = vwapDistPct(
      candles.map((c) => ({
        time: c.time,
        high: c.high,
        low: c.low,
        close: c.close,
        vol: c.vol,
      })),
      spyLast
    );
  }
  return {
    vix,
    spyChange,
    qqqChange,
    spyAdx,
    spyRsi,
    spyVwapDist,
    putCallRatio: null,
    spyVolRatio: 1,
  };
}

async function fetchAccountEquity() {
  const acc = process.env.TRADIER_ACCOUNT_ID;
  if (!acc) return 100000;
  try {
    const j = await tradier("/v1/accounts/" + acc + "/balances", {});
    const b = j.balances || j;
    return (
      parseFloat(b.total_equity ?? b.equity ?? b.total_cash ?? 0) || 100000
    );
  } catch {
    return 100000;
  }
}

function extractTickersFromText(text) {
  const u = String(text).toUpperCase();
  const m = u.match(/\b[A-Z]{2,5}\b/g) || [];
  return m.filter((t) => !TICKER_BLOCK.has(t) && t.length >= 2);
}

async function serperQueries(apiKey) {
  const ny = new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
  });
  const queries = [
    "unusual options activity today",
    "most active options today " + ny,
    "hot stocks market movers today " + ny,
    "breaking news stocks catalyst today " + ny,
  ];
  const found = new Set();
  for (const q of queries) {
    try {
      const res = await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ q }),
      });
      const data = await res.json();
      const organic = data.organic || [];
      for (const o of organic) {
        const blob = (o.title || "") + " " + (o.snippet || "");
        extractTickersFromText(blob).forEach((t) => found.add(t));
      }
    } catch {
      /* skip query */
    }
  }
  return found;
}

async function claudeAnalyze(
  setup,
  memorySnippet,
  master,
  ticker,
  priceNum,
  memory,
  scannerIgnition
) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL_SCANNER || "claude-haiku-4-5-20251001";
  if (!key) {
    return {
      text: "AI key not configured.",
      parsed: parseClaudeResponse(""),
    };
  }
  const mergedMaster =
    master != null
      ? {
          ...master,
          ignition:
            normalizeIgnitionForContext(scannerIgnition) || master.ignition,
        }
      : normalizeIgnitionForContext(scannerIgnition)
        ? { ignition: normalizeIgnitionForContext(scannerIgnition) }
        : null;
  const context = buildTradingContext(
    mergedMaster,
    ticker,
    priceNum,
    memory
  );
  const system = withSohelContext(
    `Analyze this options setup and tell Sohel exactly what to do right now.
Be specific. Give entry, stop, target.
Maximum 4 sentences.`,
    context
  );
  const macdN = parseFloat(setup.macd);
  const user =
    setup.ticker +
    " " +
    setup.setupType +
    " | Score: " +
    setup.score +
    "/100\nADX:" +
    setup.adx +
    " MACD:" +
    (macdN >= 0 ? "+" : "") +
    setup.macd +
    "\nRSI:" +
    setup.rsi +
    " VWAP:" +
    (parseFloat(setup.vwapDist) >= 0 ? "+" : "") +
    setup.vwapDist +
    "%\nOption: " +
    setup.strike +
    " " +
    setup.expiry +
    " $" +
    setup.mid +
    " Δ" +
    setup.delta +
    (memorySnippet ? "\n\nNOTES:\n" + memorySnippet : "");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await res.json();
  const text =
    data.content?.[0]?.text ||
    data.error?.message ||
    "No AI response.";
  const trimmed = String(text).trim();
  return { text: trimmed, parsed: parseClaudeResponse(trimmed) };
}

async function sendTelegram(text) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  await fetch(
    "https://api.telegram.org/bot" + bot + "/sendMessage",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        parse_mode: "HTML",
        text,
      }),
    }
  );
}

async function sendResend(subject, html) {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.ALERT_EMAIL;
  const from =
    process.env.RESEND_FROM_EMAIL || "SOHELATOR <onboarding@resend.dev>";
  if (!apiKey || !to) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
}

function midOpt(o) {
  if (!o) return 0;
  const bid = parseFloat(o.bid || 0),
    ask = parseFloat(o.ask || 0);
  if (bid && ask) return (bid + ask) / 2;
  return parseFloat(o.last || o.mid || 0);
}

function ivOpt(o) {
  if (!o) return 0;
  if (o.greeks?.mid_iv != null) return parseFloat(o.greeks.mid_iv) * 100;
  const iv = parseFloat(o.implied_volatility || 0);
  return iv < 2 ? iv * 100 : iv;
}

async function fetchOptionLeg(sym, underlying, setupType, price) {
  const expData = await tradier("/v1/markets/options/expirations", {
    symbol: sym,
    includeAllRoots: "true",
  });
  const dates = expData.expirations?.date || expData.expirations?.expiration;
  const expList = normList(dates).map(String).sort();
  let pick = null;
  for (const e of expList) {
    const t = new Date(e + "T12:00:00");
    const dte = Math.round((t - Date.now()) / 86400000);
    if (dte >= 5 && dte <= 21) {
      pick = e;
      break;
    }
  }
  if (!pick && expList.length) pick = expList[0];
  if (!pick)
    return {
      strike: "—",
      expiry: "—",
      mid: 0,
      delta: "—",
      iv: 0,
      occ: "",
      optType: "call",
    };

  const chain = await tradier("/v1/markets/options/chains", {
    symbol: sym,
    expiration: pick,
    greeks: "true",
  });
  const opts = normList(chain.options?.option);
  const strikes = [...new Set(opts.map((o) => parseFloat(o.strike)))].sort(
    (a, b) => a - b
  );
  let atm = strikes[0];
  let best = Infinity;
  for (const s of strikes) {
    const d = Math.abs(s - price);
    if (d < best) {
      best = d;
      atm = s;
    }
  }
  let optType = "call";
  if (/PUT fade|BEAR TREND|BEAR/i.test(setupType) && !/BULL TREND|BULL|CALL bounce/i.test(setupType)) {
    optType = "put";
  }
  if (/CALL bounce/i.test(setupType)) optType = "call";
  if (/PUT fade/i.test(setupType)) optType = "put";

  const pool = opts.filter((o) => o.option_type === optType);
  const atmLeg = pool.find((o) => parseFloat(o.strike) === atm);
  const otm = optType === "call"
    ? pool.filter((o) => parseFloat(o.strike) > atm).sort((a, b) => parseFloat(a.strike) - parseFloat(b.strike))[0]
    : pool.filter((o) => parseFloat(o.strike) < atm).sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike))[0];
  const leg = otm || atmLeg || pool[0];
  if (!leg)
    return {
      strike: "—",
      expiry: pick,
      mid: 0,
      delta: "—",
      iv: 0,
      occ: "",
      optType,
    };
  const mid = midOpt(leg);
  const iv = ivOpt(leg);
  const del =
    leg.greeks?.delta != null
      ? parseFloat(leg.greeks.delta).toFixed(2)
      : "—";
  return {
    strike: leg.strike,
    expiry: pick,
    mid,
    delta: del,
    iv: iv.toFixed(0),
    occ: leg.symbol,
    optType,
  };
}

async function runScan() {
  const scannerStore = getStore({
    name: "scanner",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const alertsStore = getStore({
    name: "alerts",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  if (!isEquitySessionDay(new Date())) {
    await scannerStore.setJSON("last_scan", {
      timestamp: Date.now(),
      tickersScanned: [],
      setupsFound: [],
      alertsSent: 0,
      skipped: true,
      reason: "nyse holiday or weekend",
    });
    await recordJobOk("scanner", { skipped: true, reason: "holiday" });
    return { ok: true, skipped: true, reason: "holiday" };
  }
  let alertCount = 0;
  const confirmedSetups = [];
  const tickerList = [];

  let clockState = "unknown";
  try {
    const clock = await tradier("/v1/markets/clock", {});
    const st = clock.clock?.state || clock.state;
    clockState = st != null ? String(st) : "unknown";
    if (st !== "open") {
      console.log("market status:", clockState);
      await scannerStore.setJSON("last_scan", {
        timestamp: Date.now(),
        tickersScanned: [],
        setupsFound: [],
        alertsSent: 0,
        skipped: true,
        reason: "market not open",
      });
      await recordJobOk("scanner", {
        skipped: true,
        reason: "market not open",
      });
      return { ok: true, skipped: true, reason: "market not open" };
    }
  } catch (e) {
    clockState = "error";
    /* continue if clock fails */
  }
  console.log("market status:", clockState);

  let regime = calculateRegime({
    vix: 18,
    spyChange: 0,
    qqqChange: 0,
    spyAdx: 22,
    spyRsi: 50,
    spyVwapDist: 0,
  });
  let memory = {
    insights: [],
    allTickerStats: [],
    allPatternStats: [],
    behavioralStats: null,
  };
  let accountEquity = 100000;
  let snapMap = {};
  try {
    regime = calculateRegime(await fetchRegimeMarketData());
  } catch (e) {
    console.error("regime", e);
  }
  try {
    memory = await getMemoryContext();
  } catch (e) {
    console.error("memory", e);
  }
  try {
    accountEquity = await fetchAccountEquity();
  } catch (e) {
    console.error("equity", e);
  }
  try {
    snapMap =
      (await scannerStore.get("ticker_indicator_snapshots", {
        type: "json",
      })) || {};
  } catch {
    snapMap = {};
  }
  const th = regime.thresholds;

  let pnlMap = {};
  try {
    pnlMap = await fetchUnderlyingPnlMap();
  } catch {
    pnlMap = {};
  }

  const serperKey = process.env.SERPER_API_KEY;
  let discovered = new Set();
  if (serperKey) {
    discovered = await serperQueries(serperKey);
  }
  const merged = [...new Set([...BASE_WATCH, ...discovered])].slice(0, 30);
  tickerList.push(...merged);

  const quotesData = await tradier("/v1/markets/quotes", {
    symbols: merged.join(","),
    greeks: "false",
  });
  const quotes = normList(quotesData.quotes?.quote);
  const filtered = [];
  for (const q of quotes) {
    const last = parseFloat(q.last ?? q.close ?? q.bid ?? 0);
    const vol = parseFloat(
      q.volume ?? q.last_volume ?? q.average_volume ?? 0
    );
    if (last >= 10 && vol >= 500000) {
      filtered.push({
        symbol: q.symbol,
        last,
        change: parseFloat(q.change_percentage ?? q.percent_change ?? 0),
        vol,
        raw: q,
      });
    }
  }
  filtered.sort((a, b) => b.vol - a.vol);
  const capped = filtered.slice(0, 18);
  console.log("tickers fetched:", quotes.length, "after filter:", capped.length);

  const end = new Date();
  const start = new Date(end.getTime() - 2 * 86400000);
  const ymd = (d) => d.toISOString().slice(0, 10);

  const analyzed = [];
  const batchSize = 6;
  for (let i = 0; i < capped.length; i += batchSize) {
    const chunk = capped.slice(i, i + batchSize);
    await Promise.all(
      chunk.map(async ({ symbol, last, change }) => {
        try {
          const ts = await tradier("/v1/markets/timesales", {
            symbol,
            interval: "5min",
            start: ymd(start),
            end: ymd(end),
            session_filter: "open",
          });
          const raw = normList(ts.series?.data);
          const candles = raw
            .map((c) => ({
              time: c.time || c.timestamp,
              open: parseFloat(c.open),
              high: parseFloat(c.high),
              low: parseFloat(c.low),
              close: parseFloat(c.close),
              vol: parseFloat(c.volume || c.volum || 0),
            }))
            .filter((c) => !isNaN(c.close));
          if (candles.length < 40) return;

          const closes = candles.map((c) => c.close);
          const adxCandles = candles.map((c) => ({
            high: c.high,
            low: c.low,
            close: c.close,
          }));
          const adxVal = calcADX(adxCandles, 14);
          const adxPrev = calcADX(adxCandles.slice(0, -6), 14);
          const { hist: macdHist } = calcMACD(closes);
          const rsi14 = calcRSI(closes, 14);
          const rsi2 = calcRSI(closes, 2);
          const bbB = bollingerPctB(closes, 20);
          const vwapDist = vwapDistPct(
            candles.map((c) => ({
              time: c.time,
              high: c.high,
              low: c.low,
              close: c.close,
              vol: c.vol,
            })),
            last
          );
          const ema8 = emaLast(closes, 8);
          const ema21 = emaLast(closes, 21);
          const price = last;

          let bull = 0;
          if (adxVal > 25) bull += 25;
          if (macdHist > 0) bull += 20;
          if (rsi14 >= 50 && rsi14 <= 70) bull += 20;
          if (vwapDist > 0) bull += 20;
          if (bbB > 0.5) bull += 10;
          if (ema8 > ema21) bull += 5;

          let bear = 0;
          if (adxVal > 25) bear += 25;
          if (macdHist < 0) bear += 20;
          if (rsi14 >= 30 && rsi14 <= 50) bear += 20;
          if (vwapDist < 0) bear += 20;
          if (bbB < 0.5) bear += 10;
          if (ema8 < ema21) bear += 5;

          const volAvg =
            candles.slice(-21, -1).reduce((a, c) => a + c.vol, 0) / 20 || 1;
          const lastVol = candles[candles.length - 1].vol;
          const hi20 = Math.max(
            ...candles.slice(-21, -1).map((c) => c.high)
          );
          const breakout =
            adxPrev < 20 &&
            adxVal >= 20 &&
            lastVol > volAvg * 1.5 &&
            price > hi20;

          const reversal =
            (rsi2 < 5 || rsi2 > 95) && threeSameDir(closes);

          const bullOk = bull >= 75;
          const bearOk = bear >= 75;

          const adxSlope =
            adxCandles.length >= 18
              ? adxVal - calcADX(adxCandles.slice(0, -3), 14)
              : 0;
          const macdHistPast =
            closes.length >= 38
              ? calcMACD(closes.slice(0, -3)).hist
              : macdHist;
          const macdSlope = macdHist - macdHistPast;

          const stageInfo = detectIntradayStage({
            adxVal,
            adxSlope,
            macdHist,
            macdSlope,
            rsi14,
            vwapDist,
            bbB,
            bull,
            bear,
            breakout,
            reversal,
            rsi2,
            ema8,
            ema21,
            bullOk,
            bearOk,
          });

          if (!shouldSendStageAlert(stageInfo.stage, symbol, pnlMap)) return;

          let setupType = "";
          let rank = 0;
          if (bullOk) {
            setupType = "BULL TREND";
            rank = Math.max(rank, bull);
          }
          if (bearOk) {
            setupType = rank ? setupType + " + BEAR" : "BEAR TREND";
            rank = Math.max(rank, bear);
          }
          if (breakout) {
            setupType = setupType ? setupType + " + BREAKOUT" : "BREAKOUT";
            rank = Math.max(rank, 82);
          }
          if (reversal) {
            const tag =
              rsi2 < 5 ? "REVERSAL (CALL bounce)" : "REVERSAL (PUT fade)";
            setupType = setupType ? setupType + " + " + tag : tag;
            rank = Math.max(rank, 78);
          }
          if (!setupType) {
            setupType =
              stageInfo.stage === "setup_bull"
                ? "BULL SETUP"
                : stageInfo.stage === "setup_bear"
                  ? "BEAR SETUP"
                  : stageInfo.stageLabel || "SCAN";
            rank = Math.max(rank, Math.max(bull, bear, 60));
          }

          const candlesForVol = candles.map((c) => ({
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.vol || 0,
          }));
          const volAnalysis = analyzeVolume(candlesForVol, { last: price });

          let adjRank = rank;
          if (volAnalysis) {
            if (
              volAnalysis.isSurge &&
              volAnalysis.priceVolumeSignal &&
              volAnalysis.priceVolumeSignal.includes("BULLISH")
            ) {
              adjRank += 15;
            }
            if (volAnalysis.hasVolumeDivergence) adjRank -= 20;
            if (volAnalysis.isClimaxVolume) adjRank -= 15;
            if (volAnalysis.isVolumeDryUp) adjRank += 10;
            if (volAnalysis.vwapCrossVolume) adjRank += 20;
          }
          adjRank = Math.max(0, Math.min(100, Math.round(adjRank)));

          const macdPrevIgn = calcMACD(closes.slice(0, -1)).hist;
          const macdPrev2Ign =
            closes.length >= 3 ? calcMACD(closes.slice(0, -2)).hist : macdPrevIgn;
          const rsiPrevIgn =
            closes.length >= 2 ? calcRSI(closes.slice(0, -1), 14) : rsi14;
          const adxPrevIgn =
            adxCandles.length >= 16
              ? calcADX(adxCandles.slice(0, -1), 14)
              : adxVal;

          const candlesIg = candles.map((c) => ({
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.vol || 0,
          }));
          const ignitionRaw = calculateIgnition(candlesIg, {
            macd: macdHist,
            macdPrev: macdPrevIgn,
            macdPrev2: macdPrev2Ign,
            rsi: rsi14,
            rsiPrev: rsiPrevIgn,
            adx: adxVal,
            adxPrev: adxPrevIgn,
          });

          let ignAdj = adjRank;
          if (ignitionRaw) {
            if (ignitionRaw.status === "LAUNCH") ignAdj += 20;
            else if (ignitionRaw.status === "IGNITING") ignAdj += 10;
            else if (ignitionRaw.status === "COLD") ignAdj -= 15;
          }
          ignAdj = Math.max(0, Math.min(100, Math.round(ignAdj)));

          const ignition =
            ignitionRaw != null
              ? {
                  score: ignitionRaw.ignitionScore,
                  status: ignitionRaw.status,
                  direction: ignitionRaw.direction,
                  engines: ignitionRaw.engines,
                }
              : null;

          analyzed.push({
            ticker: symbol,
            price,
            change,
            adx: adxVal.toFixed(1),
            macd: macdHist.toFixed(4),
            macdHist,
            rsi: rsi14.toFixed(1),
            vwapDist: vwapDist.toFixed(2),
            bbB,
            setupType,
            score: ignAdj,
            bull,
            bear,
            breakout,
            reversal,
            rsi2,
            stage: stageInfo.stage,
            stageLabel: stageInfo.stageLabel,
            stageEmoji: stageInfo.stageEmoji,
            stageAction: stageInfo.action,
            adxSlope,
            macdSlope,
            volAnalysis,
            ignition,
          });
        } catch {
          /* one symbol failed */
        }
      })
    );
  }

  console.log("setups found:", analyzed.length);
  analyzed.sort((a, b) => b.score - a.score);
  const top5 = analyzed.slice(0, 5);

  for (const s of top5) {
    let master = null;
    try {
      master = await getMasterAnalysis(s.ticker);
    } catch (e) {
      console.error("masterAnalysis", s.ticker, e);
    }
    if (master?.skipDueToEarnings) {
      console.log("skip alert (earnings week)", s.ticker);
      continue;
    }

    const dedupKey = "alert_dedup_" + s.ticker + "_" + s.stage;
    try {
      const prev = await alertsStore.get(dedupKey, { type: "json" });
      if (
        prev &&
        typeof prev.ts === "number" &&
        Date.now() - prev.ts < 15 * 60 * 1000
      ) {
        console.log("dedup skip", s.ticker, s.stage);
        continue;
      }
    } catch (e) {
      console.error("dedup", e);
    }

    let revType = s.setupType;
    if (s.reversal) {
      revType =
        s.rsi2 < 5
          ? s.setupType.includes("BULL")
            ? s.setupType
            : "REVERSAL (CALL bounce)"
          : s.setupType.includes("BEAR")
            ? s.setupType
            : "REVERSAL (PUT fade)";
    }
    const opt = await fetchOptionLeg(
      s.ticker,
      s.ticker,
      revType,
      s.price
    );
    const macdDir = s.macdHist >= 0 ? "bullish" : "bearish";
    const finalScore =
      master?.confidence != null ? master.confidence : s.score;

    confirmedSetups.push(Object.assign({}, s, { alertScore: finalScore }));

    const memParts = [];
    if (memory?.insights?.length) {
      memParts.push(memory.insights.slice(0, 6).join("\n"));
    }
    if (master?.claudeContext) {
      memParts.push(master.claudeContext);
    }
    const memorySnippet = memParts.join("\n\n");

    console.log("calling Claude...", s.ticker);
    const aiResult = await claudeAnalyze(
      {
        ticker: s.ticker,
        price: s.price.toFixed(2),
        change: s.change.toFixed(2),
        setupType: s.setupType,
        adx: s.adx,
        macd: s.macd,
        rsi: s.rsi,
        vwapDist: s.vwapDist,
        strike: opt.strike,
        expiry: opt.expiry,
        mid: opt.mid.toFixed(2),
        delta: opt.delta,
        iv: opt.iv,
        score: finalScore,
        stage: s.stage,
        stageLabel: s.stageLabel,
      },
      memorySnippet,
      master,
      s.ticker,
      s.price,
      memory,
      s.ignition
    );
    const aiAnalysis = aiResult.text;
    const aiAnalysisParsed = aiResult.parsed;
    console.log("Claude response received", s.ticker);

    const indicators = {
      adx: s.adx,
      rsi: s.rsi,
      macd: s.macd,
      vwapDist: s.vwapDist,
      bbB: s.bbB,
      price: s.price,
      adxSlope: s.adxSlope,
      macdSlope: s.macdSlope,
    };

    const ivNum = parseFloat(String(opt.iv).replace(/%/g, "")) || 0;

    const volAtAlert = s.volAnalysis
      ? {
          ratio: s.volAnalysis.currentVolRatio,
          signal: s.volAnalysis.priceVolumeSignal,
          alerts: s.volAnalysis.alerts,
          interpretation: s.volAnalysis.interpretation,
        }
      : null;

    const patternWin = memory?.allPatternStats?.find(
      (p) => p.stage === s.stage
    );
    const winRate =
      patternWin?.winRate != null && patternWin.totalTrades >= 2
        ? patternWin.winRate
        : null;

    const urgency = calculateUrgency(
      {
        ticker: s.ticker,
        stage: s.stage,
        score: finalScore,
        indicators: {
          adx: parseFloat(s.adx) || 0,
          rsi: parseFloat(s.rsi) || 0,
          macd: parseFloat(s.macd) || 0,
          vwapDist: parseFloat(s.vwapDist) || 0,
          volRatio: s.volAnalysis?.currentVolRatio,
        },
        option: opt,
      },
      regime,
      memory
    );

    const pending = {
      ticker: s.ticker,
      setupType: s.setupType,
      score: finalScore,
      scannerScore: s.score,
      price: s.price,
      change: s.change,
      aiAnalysis,
      stage: s.stage,
      stageLabel: s.stageLabel,
      stageEmoji: s.stageEmoji,
      action: s.stageAction,
      optionSymbol: opt.occ,
      premiumAtAlert: opt.mid,
      ivAtEntry: ivNum,
      underlyingAtAlert: s.price,
      direction: opt.optType,
      volume: volAtAlert,
      masterAnalysis: master
        ? {
            confidence: master.confidence,
            tradingBias: master.tradingBias,
            summary: master.summary,
            gex: master.gex,
            marketProfile: master.marketProfile,
            optionsFlow: master.optionsFlow,
            sector: master.sector,
            levels: master.levels,
            recommendedOption: master.recommendedOption,
            optimalStrike: master.optimalStrike,
          }
        : null,
      option: {
        strike: opt.strike,
        expiry: opt.expiry,
        mid: opt.mid,
        delta: opt.delta,
        iv: opt.iv,
        occ: opt.occ,
        optType: opt.optType,
      },
      indicators,
      macdDir,
      ignition: s.ignition || null,
      aiAnalysisParsed: aiAnalysisParsed || null,
      timestamp: Date.now(),
      winRate,
      urgencyTier: urgency.tier,
    };

    const pendingKey = "pending_" + Date.now() + "_" + s.ticker;
    await alertsStore.setJSON(pendingKey, pending);

    const alertKey = "alert_" + Date.now() + "_" + s.ticker;
    const alertRecord = {
      id: alertKey,
      ticker: s.ticker,
      setupType: s.setupType,
      score: finalScore,
      scannerScore: s.score,
      stage: s.stage,
      stageLabel: s.stageLabel,
      stageEmoji: s.stageEmoji,
      action: s.stageAction,
      indicators,
      option: pending.option,
      optionSymbol: opt.occ,
      premiumAtAlert: opt.mid,
      ivAtEntry: ivNum,
      underlyingAtAlert: s.price,
      direction: opt.optType,
      masterAnalysis: pending.masterAnalysis,
      volume: volAtAlert,
      aiAnalysis,
      aiAnalysisParsed: pending.aiAnalysisParsed,
      ignition: pending.ignition,
      timestamp: Date.now(),
      outcome: null,
      winRate,
      urgencyTier: urgency.tier,
    };
    await alertsStore.setJSON(alertKey, alertRecord);

    try {
      await recordAlertSnapshot(alertRecord, master);
    } catch (e) {
      console.error("recordAlertSnapshot", s.ticker, e);
    }

    const volLine = s.volAnalysis?.isSurge
      ? `🔊 VOL: ${s.volAnalysis.currentVolRatio}x avg — ${s.volAnalysis.priceVolumeSignal}`
      : `📊 VOL: ${s.volAnalysis?.currentVolRatio ?? "—"}x avg`;

    const holdType =
      /PUT|BEAR|fade/i.test(revType) && !/BULL|CALL bounce/i.test(revType)
        ? "SWING (bear)"
        : "SWING (bull)";
    const ignLine =
      s.ignition?.status === "LAUNCH"
        ? `🚀 IGNITION: ${s.ignition.score}/100 — ALL 3 ENGINES FIRING`
        : s.ignition?.status === "IGNITING"
          ? `⚡ IGNITING: ${s.ignition.score}/100 — move building`
          : `📊 IGNITION: ${s.ignition?.score ?? "—"}/100`;
    const tg =
      (s.stageEmoji || "🔥") +
      " <b>" +
      escapeHtml(s.stageLabel || s.setupType) +
      " — " +
      escapeHtml(s.ticker) +
      "</b>\n\n" +
      escapeHtml(s.setupType) +
      " | Score: " +
      finalScore +
      "/100\n" +
      "HOLD TYPE: " +
      holdType +
      " | EXIT: structure break / -40% prem | TIME: 1–3d swing\n" +
      "💰 Price: $" +
      s.price.toFixed(2) +
      " (" +
      s.change.toFixed(2) +
      "%)\n" +
      "📊 ADX: " +
      s.adx +
      " | RSI: " +
      s.rsi +
      " | MACD: " +
      macdDir +
      "\n" +
      ignLine +
      "\n" +
      volLine +
      "\n" +
      "🎯 <b>Play: " +
      escapeHtml(String(opt.strike)) +
      " @ $" +
      opt.mid.toFixed(2) +
      "</b>\n" +
      "📅 Exp: " +
      escapeHtml(String(opt.expiry)) +
      " | Delta: " +
      escapeHtml(String(opt.delta)) +
      "\n\n" +
      "🤖 <i>" +
      escapeHtml(aiAnalysis) +
      "</i>\n\n" +
      "⚠️ Stop: -40% | Target: +80%";

    await sendTelegram(tg);

    const html =
      "<h2>🔥 " +
      escapeHtml(s.setupType) +
      " — " +
      escapeHtml(s.ticker) +
      "</h2>" +
      "<p>Score: " +
      finalScore +
      "/100 | Price: $" +
      s.price.toFixed(2) +
      " (" +
      s.change.toFixed(2) +
      "%)</p>" +
      "<p>ADX: " +
      s.adx +
      " | RSI: " +
      s.rsi +
      " | MACD: " +
      macdDir +
      " | VWAP dist: " +
      s.vwapDist +
      "%</p>" +
      "<p><strong>Option:</strong> " +
      escapeHtml(String(opt.strike)) +
      " " +
      escapeHtml(String(opt.expiry)) +
      " @ $" +
      opt.mid.toFixed(2) +
      " Δ " +
      escapeHtml(String(opt.delta)) +
      " IV " +
      opt.iv +
      "%</p>" +
      "<p><em>" +
      escapeHtml(aiAnalysis) +
      "</em></p>";

    await sendResend(
      "🔥 " +
        s.setupType +
        " Alert: " +
        s.ticker +
        " | Score " +
        finalScore +
        "/100",
      html
    );

    await sendPushToAll({
      title: "SOHELATOR: " + s.ticker + " — " + s.setupType,
      body:
        "Score " +
        finalScore +
        "/100 · " +
        (master?.summary ? master.summary.slice(0, 80) + "… · " : "") +
        aiAnalysis.slice(0, 100) +
        "…",
      data: { url: "/", ticker: s.ticker },
    });

    try {
      await alertsStore.setJSON(dedupKey, { ts: Date.now() });
    } catch (e) {
      console.error("dedup write", e);
    }

    alertCount++;
    await new Promise((r) => setTimeout(r, 250));
  }

  let history = [];
  try {
    const h = await scannerStore.get("alert_history", { type: "json" });
    if (Array.isArray(h)) history = h;
  } catch {
    /* none */
  }
  for (let i = top5.length - 1; i >= 0; i--) {
    const s = top5[i];
    const cs = confirmedSetups.find((c) => c.ticker === s.ticker);
    const histScore = cs?.alertScore ?? cs?.score ?? s.score;
    history.unshift({
      ticker: s.ticker,
      setupType: s.setupType,
      score: histScore,
      timestamp: Date.now(),
      outcome: null,
    });
  }
  history = history.slice(0, 10);
  await scannerStore.setJSON("alert_history", history);

  await scannerStore.setJSON("last_scan", {
    timestamp: Date.now(),
    tickersScanned: tickerList,
    setupsFound: confirmedSetups.map((c) => ({
      ticker: c.ticker,
      setupType: c.setupType,
      score: c.alertScore ?? c.score,
      scannerScore: c.score,
    })),
    alertsSent: alertCount,
  });

  await recordJobOk("scanner", {
    alertsSent: alertCount,
    setups: confirmedSetups.length,
  });

  return {
    ok: true,
    tickersScanned: tickerList.length,
    setupsFound: confirmedSetups.length,
    alertsSent: alertCount,
  };
}

module.exports = {
  runScan,
  calcRSI,
  calcMACD,
  calcADX,
  detectStage: detectIntradayStage,
};
