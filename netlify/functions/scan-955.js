const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");
const { withSohelContext, buildTradingContext } = require("./lib/sohelContext");
const { getMemoryContext } = require("./lib/memory");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { recordJobOk, recordJobError } = require("./lib/jobHealth");
const { isScanForceRequested } = require("./lib/scanForce");

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradierGet(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))
  ).toString();
  const res = await fetch(tradierBase() + path + (qs ? "?" + qs : ""), {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

function nyHM() {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(new Date());
  return {
    h: +p.find((x) => x.type === "hour").value,
    m: +p.find((x) => x.type === "minute").value,
  };
}

function nyYmd() {
  return new Date().toLocaleDateString("en-CA", {
    timeZone: "America/New_York",
  });
}

function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) {
    if (closes.length < 3) return 50;
    p = closes.length - 1;
  }
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

function calcMACDShort(closes) {
  if (closes.length < 5) return { hist: 0, direction: "flat", expanding: false };
  const k3 = 2 / 4,
    k5 = 2 / 6,
    k2 = 2 / 3;
  let e3 = closes[0],
    e5 = closes[0];
  const ml = [];
  for (let i = 1; i < closes.length; i++) {
    e3 = closes[i] * k3 + e3 * (1 - k3);
    e5 = closes[i] * k5 + e5 * (1 - k5);
    ml.push(e3 - e5);
  }
  if (!ml.length) return { hist: 0, direction: "flat", expanding: false };
  let sig = ml[0];
  for (let i = 1; i < ml.length; i++) sig = ml[i] * k2 + sig * (1 - k2);
  const hist = ml[ml.length - 1] - sig;
  const prevHist = ml.length > 1 ? ml[ml.length - 2] - sig : hist;
  return {
    hist,
    direction: hist > 0 ? "positive" : "negative",
    expanding: Math.abs(hist) > Math.abs(prevHist),
  };
}

function calcVWAP(candles) {
  let pv = 0,
    v = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const vol = c.volume || 1;
    pv += tp * vol;
    v += vol;
  }
  return v > 0 ? pv / v : 0;
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

async function fetchOption(sym, price, optType) {
  const expData = await tradierGet("/v1/markets/options/expirations", {
    symbol: sym,
    includeAllRoots: "true",
  });
  const dates = expData.expirations?.date || expData.expirations?.expiration;
  const expList = normList(dates).map(String).sort();
  let pick = null;
  for (const e of expList) {
    const dte = Math.round(
      (new Date(e + "T12:00:00") - Date.now()) / 86400000
    );
    if (dte >= 5 && dte <= 14) {
      pick = e;
      break;
    }
  }
  if (!pick && expList.length) pick = expList[0];
  if (!pick) return null;
  const chain = await tradierGet("/v1/markets/options/chains", {
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
  const pool = opts.filter((o) => o.option_type === optType);
  const otm =
    optType === "call"
      ? pool
          .filter((o) => parseFloat(o.strike) > atm)
          .sort((a, b) => parseFloat(a.strike) - parseFloat(b.strike))[0]
      : pool
          .filter((o) => parseFloat(o.strike) < atm)
          .sort((a, b) => parseFloat(b.strike) - parseFloat(a.strike))[0];
  const leg = otm || pool.find((o) => parseFloat(o.strike) === atm) || pool[0];
  if (!leg) return null;
  return {
    strike: leg.strike,
    expiry: pick,
    mid: midOpt(leg),
    delta:
      leg.greeks?.delta != null
        ? parseFloat(leg.greeks.delta).toFixed(2)
        : "—",
    iv: ivOpt(leg).toFixed(0),
    occ: leg.symbol,
  };
}

function detect955Stage(ctx) {
  const {
    rsi,
    macd,
    vwapDist,
    aboveOR,
    belowOR,
    volSurge,
    OR_rangePct,
    aboveVWAP,
    inOR,
  } = ctx;
  const breakoutBull =
    aboveOR && aboveVWAP && macd.direction === "positive" && volSurge;
  const breakoutBear =
    belowOR && !aboveVWAP && macd.direction === "negative" && volSurge;
  const failedBreakout =
    (aboveOR && !aboveVWAP) || (belowOR && aboveVWAP);
  const stillForming = inOR && OR_rangePct < 0.8;

  if (breakoutBull)
    return {
      stage: "bull",
      label: "BULL CONFIRMED",
      action: "BUY CALLS NOW",
      winRate: 72,
      emoji: "✅",
      confidence: "HIGH",
    };
  if (breakoutBear)
    return {
      stage: "bear",
      label: "BEAR CONFIRMED",
      action: "BUY PUTS NOW",
      winRate: 68,
      emoji: "🔴",
      confidence: "HIGH",
    };
  if (aboveOR && aboveVWAP && macd.direction === "positive" && !volSurge)
    return {
      stage: "setup_bull",
      label: "BULL SETTING UP",
      action: "WATCH — needs volume",
      winRate: null,
      emoji: "🔍",
      confidence: "MEDIUM",
    };
  if (belowOR && !aboveVWAP && macd.direction === "negative" && !volSurge)
    return {
      stage: "setup_bear",
      label: "BEAR SETTING UP",
      action: "WATCH — needs volume",
      winRate: null,
      emoji: "🔍",
      confidence: "MEDIUM",
    };
  if (failedBreakout)
    return {
      stage: "fading",
      label: "SETUP FAILED",
      action: "SKIP THIS ONE",
      winRate: null,
      emoji: "⚡",
      confidence: "SKIP",
    };
  if (stillForming)
    return {
      stage: "chop",
      label: "STILL FORMING",
      action: "WAIT 10 MORE MINUTES",
      winRate: null,
      emoji: "⏳",
      confidence: "WAIT",
    };
  return {
    stage: "chop",
    label: "NO CLEAR EDGE",
    action: "SKIP",
    winRate: null,
    emoji: "⚠️",
    confidence: "LOW",
  };
}

async function run955(event) {
  const forced = isScanForceRequested(event);
  if (!forced) {
    const { h, m } = nyHM();
    if (h !== 9 || m < 50 || m > 59) {
      return {
        statusCode: 200,
        headers: { ...cors, "Content-Type": "application/json" },
        body: JSON.stringify({
          skipped: true,
          reason:
            "Outside 9:50–9:59 AM ET. Set SCAN_FORCE_SECRET and POST ?force=<secret> to test.",
        }),
      };
    }
  }

  const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
  const scan925 = await store.get("scan_925_latest", { type: "json" });
  let watchTickers = scan925
    ? [
        ...scan925.watchlistBull.map((t) => t.symbol),
        ...scan925.watchlistBear.map((t) => t.symbol),
        "SPY",
        "QQQ",
      ]
    : ["NVDA", "TSLA", "SPY", "QQQ", "AAPL", "AMD", "MSFT", "META"];
  watchTickers = [...new Set(watchTickers)];
  const ymd = nyYmd();

  const qd = await tradierGet("/v1/markets/quotes", {
    symbols: watchTickers.join(","),
    greeks: "false",
  });
  const quotes = {};
  for (const q of normList(qd.quotes?.quote)) {
    if (q.symbol) quotes[q.symbol] = q;
  }

  const spyQ = quotes["SPY"];
  const qqqQ = quotes["QQQ"];
  const spyNow = parseFloat(spyQ?.last ?? 0);
  const qqqNow = parseFloat(qqqQ?.last ?? 0);
  const spyPrev = parseFloat(spyQ?.prevclose ?? spyNow);
  const qqqPrev = parseFloat(qqqQ?.prevclose ?? qqqNow);
  const spyChangePct = spyPrev ? ((spyNow - spyPrev) / spyPrev) * 100 : 0;
  const qqqChangePct = qqqPrev ? ((qqqNow - qqqPrev) / qqqPrev) * 100 : 0;
  const broadDir =
    spyChangePct > 0.1 && qqqChangePct > 0.1
      ? "up"
      : spyChangePct < -0.1 && qqqChangePct < -0.1
        ? "down"
        : "mixed";

  const analyses = [];
  for (const sym of watchTickers) {
    if (sym === "SPY" || sym === "QQQ") continue;
    try {
      const ts = await tradierGet("/v1/markets/timesales", {
        symbol: sym,
        interval: "5min",
        start: ymd,
        end: ymd,
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
          volume: parseFloat(c.volume || c.volum || 0),
        }))
        .filter((c) => !isNaN(c.close));
      if (candles.length < 4) continue;

      const openCandles = candles.slice(0, 3);
      const OR_high = Math.max(...openCandles.map((c) => c.high));
      const OR_low = Math.min(...openCandles.map((c) => c.low));
      const OR_mid = (OR_high + OR_low) / 2;
      const OR_range = OR_high - OR_low;
      const OR_rangePct = OR_low ? (OR_range / OR_low) * 100 : 0;
      const currentPrice = candles[candles.length - 1].close;
      const aboveOR = currentPrice > OR_high;
      const belowOR = currentPrice < OR_low;
      const inOR = !aboveOR && !belowOR;
      const closes = candles.map((c) => c.close);
      const rsi = calcRSI(closes);
      const macd = calcMACDShort(closes);
      const vwap = calcVWAP(candles);
      const vwapDist = vwap ? ((currentPrice - vwap) / vwap) * 100 : 0;
      const aboveVWAP = currentPrice > vwap;
      const openVol = candles.reduce((s, c) => s + c.volume, 0);
      const avgCandleVol = openVol / candles.length;
      const lastCandleVol = candles[candles.length - 1].volume;
      const volSurge = lastCandleVol > avgCandleVol * 1.5;
      const q = quotes[sym];
      const prev = parseFloat(q?.prevclose ?? currentPrice);
      const changePct = prev ? ((currentPrice - prev) / prev) * 100 : 0;

      const stage = detect955Stage({
        rsi,
        macd,
        vwapDist,
        aboveOR,
        belowOR,
        volSurge,
        OR_rangePct,
        aboveVWAP,
        inOR,
      });

      const called925 =
        scan925?.watchlistBull?.find((t) => t.symbol === sym) ||
        scan925?.watchlistBear?.find((t) => t.symbol === sym);

      let option = null;
      if (stage.stage === "bull")
        option = await fetchOption(sym, currentPrice, "call");
      if (stage.stage === "bear")
        option = await fetchOption(sym, currentPrice, "put");

      analyses.push({
        symbol: sym,
        currentPrice,
        changePct,
        OR_high,
        OR_low,
        OR_mid,
        OR_rangePct,
        aboveOR,
        belowOR,
        inOR,
        rsi,
        macd,
        vwapDist,
        aboveVWAP,
        volSurge,
        openVol,
        stage,
        option,
        called925: !!called925,
      });
    } catch {
      /* skip symbol */
    }
  }

  const confirmedTickers = analyses.filter(
    (a) => a.stage.stage === "bull" || a.stage.stage === "bear"
  );

  const masterBySymbol = {};
  await Promise.all(
    confirmedTickers.slice(0, 5).map(async (row) => {
      try {
        const m = await getMasterAnalysis(row.symbol);
        if (m) masterBySymbol[row.symbol] = m;
      } catch (e) {
        console.error("955 master", row.symbol, e);
      }
    })
  );

  const watchingTickers = analyses.filter(
    (a) =>
      a.stage.stage === "setup_bull" || a.stage.stage === "setup_bear"
  );
  const failedTickers = analyses.filter(
    (a) => a.stage.stage === "fading" || a.stage.stage === "chop"
  );

  const model =
    process.env.ANTHROPIC_MODEL_PREMARKET || "claude-opus-4-6";
  const key = process.env.ANTHROPIC_API_KEY;
  let claudeOverall = "";
  let mem955 = {
    insights: [],
    allTickerStats: [],
    allPatternStats: [],
    behavioralStats: null,
  };
  try {
    mem955 = await getMemoryContext();
  } catch (e) {
    console.error("scan-955 memory", e);
  }
  const firstConf = confirmedTickers[0];
  const m955 = firstConf ? masterBySymbol[firstConf.symbol] : null;
  const p955 = firstConf?.currentPrice ?? spyNow;
  const openingContext = buildTradingContext(
    m955,
    firstConf?.symbol || "SPY",
    p955,
    mem955
  );

  if (key) {
    const system = withSohelContext(
      `It's 9:55am. Opening range is set.
Tell Sohel exactly what confirmed and 
what to do. For each confirmed setup:
exact option, exact entry, stop, target.
For each failed setup: why it failed.
Maximum 200 words total.`,
      openingContext
    );
    const user = `Opening range is set. Here's what confirmed:

MARKET AT 9:55am:
SPY: ${spyNow.toFixed(2)} (${spyChangePct >= 0 ? "+" : ""}${spyChangePct.toFixed(2)}%)
QQQ: ${qqqNow.toFixed(2)} (${qqqChangePct >= 0 ? "+" : ""}${qqqChangePct.toFixed(2)}%)
Broad market direction: ${broadDir}

OPENING RANGE RESULTS:
${confirmedTickers
  .map(
    (t) => `
${t.stage.emoji} ${t.symbol} — ${t.stage.label}
Price: $${t.currentPrice.toFixed(2)} (${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%)
OR Range: $${t.OR_low.toFixed(2)}-$${t.OR_high.toFixed(2)} (${t.OR_rangePct.toFixed(2)}% range)
Position: ${t.aboveOR ? "ABOVE OR" : t.belowOR ? "BELOW OR" : "INSIDE OR"}
VWAP: ${t.aboveVWAP ? "ABOVE" : "BELOW"} (dist: ${t.vwapDist.toFixed(2)}%)
MACD: ${t.macd.direction} ${t.macd.expanding ? "& EXPANDING" : ""}
RSI: ${t.rsi.toFixed(1)}
Volume: ${t.volSurge ? "SURGING" : "Normal"}
${t.option ? `Best option: ${t.option.strike} exp ${t.option.expiry} @ $${t.option.mid} delta ${t.option.delta}` : ""}
Called at 9:25: ${t.called925 ? "YES" : "No"}`
  )
  .join("\n")}

STILL WATCHING:
${watchingTickers.map((t) => `• ${t.symbol} — ${t.stage.label}: ${t.stage.action}`).join("\n")}

FAILED / SKIP:
${failedTickers.map((t) => `• ${t.symbol} — ${t.stage.label}`).join("\n")}

MASTER STACK (Tradier — GEX / flow / profile / sector):
${confirmedTickers
  .map((t) => {
    const m = masterBySymbol[t.symbol];
    return m
      ? `${t.symbol}: ${m.summary} | Profile: ${m.marketProfile?.pricePosition || "n/a"} | GEX: ${m.gex?.gexRegime || "n/a"}`
      : `${t.symbol}: (no master)`;
  })
  .join("\n")}

For each CONFIRMED setup: exact option, entry trigger, stop, target, time exit. For WATCHING: what must happen in 15 min. Overall: good morning to trade or wait? If Friday, WEEKEND HOLD ASSESSMENT per position. Use GEX flip / profile when refining targets.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1200,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    const data = await res.json();
    claudeOverall =
      data.content?.[0]?.text || data.error?.message || "";
  }

  const dateStr = new Date().toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const scan955Data = {
    type: "open_955",
    date: dateStr,
    timestamp: Date.now(),
    confirmedTickers,
    watchingTickers,
    failedTickers,
    tickerAnalyses: analyses,
    masterBySymbol: Object.fromEntries(
      Object.entries(masterBySymbol).map(([k, v]) => [
        k,
        v
          ? {
              summary: v.summary,
              confidence: v.confidence,
              gexRegime: v.gex?.gexRegime,
              profile: v.marketProfile?.pricePosition,
              sectorMomentum: v.sector?.sectorMomentum,
              flowBias: v.optionsFlow?.smartMoneyBias,
              recommendedStrike: v.recommendedOption?.strike,
            }
          : null,
      ])
    ),
    claudeAnalysis: claudeOverall,
    spyChangePct,
    qqqChangePct,
  };
  await store.setJSON("scan_955_latest", scan955Data);
  await store.setJSON("scan_955_" + dateStr.replace(/\s/g, "_"), scan955Data);

  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (bot && chat) {
    for (const t of confirmedTickers) {
      const o = t.option;
      const macdDir = t.macd.direction;
      const mm = masterBySymbol[t.symbol];
      const intel =
        mm != null
          ? `\n🧠 <b>GEX</b> ${mm.gex?.gexRegime || "—"} | <b>Profile</b> ${mm.marketProfile?.pricePosition || "—"} | <b>Sector</b> ${mm.sector?.sectorMomentum || "—"} | <b>Flow</b> ${mm.optionsFlow?.smartMoneyBias || "—"}`
          : "";
      const strikeHint =
        mm?.recommendedOption?.strike != null
          ? `\n⭐ Master strike idea: $${mm.recommendedOption.strike}`
          : "";
      const msg = `${t.stage.emoji} <b>${t.symbol} — ${t.stage.label}</b>
Called at 9:25: ${t.called925 ? "YES ✓" : "New find"}

💰 Price: $${t.currentPrice.toFixed(2)} | ${t.changePct >= 0 ? "+" : ""}${t.changePct.toFixed(2)}%
📐 OR: $${t.OR_low.toFixed(2)}-$${t.OR_high.toFixed(2)} | ${t.aboveOR ? "BROKE OUT ✅" : t.belowOR ? "BROKE DOWN 🔴" : "Inside"}
📊 VWAP: ${t.aboveVWAP ? "Above ✅" : "Below 🔴"} | MACD: ${macdDir} | RSI: ${t.rsi.toFixed(1)}
🔊 Volume: ${t.volSurge ? "SURGING 🔥" : "Normal"}
${intel}${strikeHint}

🎯 <b>PLAY: ${o ? o.strike : "—"} exp ${o ? o.expiry : "—"} @ $${o ? o.mid.toFixed(2) : "—"}</b>
Delta: ${o ? o.delta : "—"} | IV: ${o ? o.iv : "—"}%

⚡ <b>ACTION: ${t.stage.action}</b>
Stop: -40% | Target: +80-150%

🤖 ${claudeOverall.slice(0, 400)}…`;
      await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text: msg,
          parse_mode: "HTML",
        }),
      });
    }
    const sum = `📊 <b>9:55 OPENING RANGE SUMMARY</b>
Confirmed plays: ${confirmedTickers.length}
Still watching: ${watchingTickers.length}
Failed/skip: ${failedTickers.length}

${claudeOverall.slice(0, 500)}…

<i>Next: 4pm performance review</i>`;
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: sum,
        parse_mode: "HTML",
      }),
    });
  }

  try {
    await recordJobOk("scan-955", {
      timestamp: scan955Data.timestamp,
      confirmed: confirmedTickers.length,
    });
  } catch (e) {
    console.error("recordJobOk scan-955", e);
  }

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, X-Scan-Force",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

async function httpHandler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors, body: "" };
  }
  if (event.httpMethod === "GET") {
    const store = getStore({
    name: "morning-scans",
    siteID: process.env.NETLIFY_SITE_ID,
    token: process.env.NETLIFY_TOKEN,
  });
    const data = await store.get("scan_955_latest", { type: "json" });
    return {
      statusCode: 200,
      headers: { ...cors, "Content-Type": "application/json" },
      body: JSON.stringify(data || null),
    };
  }
  return run955(event).catch(async (e) => {
    console.error(e);
    await recordJobError("scan-955", e.message);
    return { statusCode: 500, body: JSON.stringify({ error: e.message }) };
  });
}

exports.handler = schedule("55 14 * * 1-5", httpHandler);
