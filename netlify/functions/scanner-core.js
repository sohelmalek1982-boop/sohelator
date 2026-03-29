const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { sendPushToAll } = require("./lib/pushAll");
const { withSohelContext } = require("./lib/sohelContext");

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

function detectIntradayStage(ctx) {
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

  if (adxVal < 20) {
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

async function claudeAnalyze(setup) {
  const key = process.env.ANTHROPIC_API_KEY;
  const model =
    process.env.ANTHROPIC_MODEL_SCANNER || "claude-haiku-4-5-20251001";
  if (!key) return "AI key not configured.";
  const system = withSohelContext(
    "Trading signal analyzer. Maximum 2 sentences. Sentence 1: name the setup type and key condition. Sentence 2: exact option to buy and why. No fluff."
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
    setup.delta;
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
  return String(text).trim();
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
  let alertCount = 0;
  const confirmedSetups = [];
  const tickerList = [];

  try {
    const clock = await tradier("/v1/markets/clock", {});
    const st = clock.clock?.state || clock.state;
    if (st !== "open") {
      await scannerStore.setJSON("last_scan", {
        timestamp: Date.now(),
        tickersScanned: [],
        setupsFound: [],
        alertsSent: 0,
        skipped: true,
        reason: "market not open",
      });
      return { ok: true, skipped: true, reason: "market not open" };
    }
  } catch (e) {
    /* continue if clock fails */
  }

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
            score: Math.round(rank),
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
          });
        } catch {
          /* one symbol failed */
        }
      })
    );
  }

  analyzed.sort((a, b) => b.score - a.score);
  const top5 = analyzed.slice(0, 5);

  for (const s of top5) {
    confirmedSetups.push(s);
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
    const aiAnalysis = await claudeAnalyze({
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
      score: s.score,
      stage: s.stage,
      stageLabel: s.stageLabel,
    });

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

    const pending = {
      ticker: s.ticker,
      setupType: s.setupType,
      score: s.score,
      price: s.price,
      change: s.change,
      aiAnalysis,
      stage: s.stage,
      stageLabel: s.stageLabel,
      stageEmoji: s.stageEmoji,
      action: s.stageAction,
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
      timestamp: Date.now(),
    };

    const pendingKey = "pending_" + Date.now() + "_" + s.ticker;
    await alertsStore.setJSON(pendingKey, pending);

    const alertKey = "alert_" + Date.now() + "_" + s.ticker;
    await alertsStore.setJSON(alertKey, {
      ticker: s.ticker,
      setupType: s.setupType,
      score: s.score,
      stage: s.stage,
      stageLabel: s.stageLabel,
      stageEmoji: s.stageEmoji,
      action: s.stageAction,
      indicators,
      option: pending.option,
      aiAnalysis,
      timestamp: Date.now(),
      outcome: null,
    });

    const holdType =
      /PUT|BEAR|fade/i.test(revType) && !/BULL|CALL bounce/i.test(revType)
        ? "SWING (bear)"
        : "SWING (bull)";
    const tg =
      (s.stageEmoji || "🔥") +
      " <b>" +
      escapeHtml(s.stageLabel || s.setupType) +
      " — " +
      escapeHtml(s.ticker) +
      "</b>\n\n" +
      escapeHtml(s.setupType) +
      " | Score: " +
      s.score +
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
      s.score +
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
      "🔥 " + s.setupType + " Alert: " + s.ticker + " | Score " + s.score + "/100",
      html
    );

    await sendPushToAll({
      title: "SOHELATOR: " + s.ticker + " — " + s.setupType,
      body: "Score " + s.score + "/100 · " + aiAnalysis.slice(0, 120) + "…",
      data: { url: "/", ticker: s.ticker },
    });

    alertCount++;
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
    history.unshift({
      ticker: s.ticker,
      setupType: s.setupType,
      score: s.score,
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
      score: c.score,
    })),
    alertsSent: alertCount,
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
