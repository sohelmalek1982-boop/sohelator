/**
 * SOHELATOR blueprint — cheap 5-min monitor + wake-up (Prompt 7)
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12)
 * SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19):
 *   POST /api/scan with suppressTelegram:true; relays quality-filtered alerts (Claude + lib/alertQuality.cjs) via Telegram.
 *
 * Schedule: netlify.toml — cron every five minutes — this function gates:
 *   • Weekday RTH 8:00–16:00 ET: every run → cheap scan + wild wakeup (score ≥72, vol ≥2.5×, text catalyst)
 *   • Weekday after-hours 16:01–20:00 ET: at most once per ET clock hour → cheap scan with Tradier news,
 *     symbols in our universe mentioned in headlines get priority; body forwards catalyst text for Grok.
 *
 * Netlify: URL / DEPLOY_PRIME_URL, TRADIER_TOKEN (news + scan), Claude via expensive /api/scan,
 * On Netlify, blobs use runtime credentials (debounce + alert-cooldowns). VAPID_* (push via lib/pushAll).
 */

const fetch = globalThis.fetch || require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { sendPushToAll } = require("./lib/pushAll.js");
const alertQuality = require("./lib/alertQuality.cjs");

function netlifyBlobRuntime() {
  return process.env.NETLIFY === "true" || !!process.env.NETLIFY_SITE_ID;
}

/** Must match DEFAULT_UNIVERSE in netlify/functions/scan.js for headline intersection. */
const SCAN_UNIVERSE = new Set([
  "SPY",
  "QQQ",
  "IWM",
  "DIA",
  "NVDA",
  "TSLA",
  "AAPL",
  "MSFT",
  "META",
  "AMD",
  "GOOGL",
  "AMZN",
  "NFLX",
  "COIN",
  "MSTR",
]);

function baseUrl() {
  return String(process.env.URL || process.env.DEPLOY_PRIME_URL || "").replace(
    /\/$/,
    ""
  );
}

function tradierBaseUrl() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

function weekdayShortEt(d) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
  }).format(d);
}

function isWeekdayEt(d) {
  const w = weekdayShortEt(d);
  return w !== "Sat" && w !== "Sun";
}

/** Minutes since midnight America/New_York */
function minutesEt(d) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  }).formatToParts(d);
  let h = 0;
  let m = 0;
  for (const p of parts) {
    if (p.type === "hour") h = parseInt(p.value, 10);
    if (p.type === "minute") m = parseInt(p.value, 10);
  }
  return h * 60 + m;
}

/** ET calendar date YYYY-MM-DD */
function ymdEt(d) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Symbols from today's 9:25 scan blob — merged into RTH cheap scan as priority + extra universe. */
async function getScan925WatchlistSyms() {
  try {
    const store = getStore('morning-scans');
    const scan925 = await store.get("scan_925_latest", { type: "json" });
    if (!scan925) return [];
    const todayLong = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (String(scan925.date || "").trim() !== String(todayLong).trim()) {
      return [];
    }
    const syms = [];
    for (const w of scan925.watchlistBull || []) {
      if (w && w.symbol) syms.push(String(w.symbol).trim().toUpperCase());
    }
    for (const w of scan925.watchlistBear || []) {
      if (w && w.symbol) syms.push(String(w.symbol).trim().toUpperCase());
    }
    return [...new Set(syms)];
  } catch (e) {
    console.warn("getScan925WatchlistSyms", e?.message || e);
    return [];
  }
}

/** After 1pm ET: Claude's revised afternoon list from brief_1pm_latest (same ET calendar day). */
async function getBrief1pmAfternoonWatchlist() {
  try {
    const store = getStore('morning-scans');
    const b = await store.get("brief_1pm_latest", { type: "json" });
    if (!b || !b.afternoonWatchlist) return null;
    const todayLong = new Date().toLocaleDateString("en-US", {
      timeZone: "America/New_York",
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    if (String(b.date || "").trim() !== String(todayLong).trim()) return null;
    return b.afternoonWatchlist;
  } catch (e) {
    console.warn("getBrief1pmAfternoonWatchlist", e?.message || e);
    return null;
  }
}

/** 8:00am–4:00pm ET weekdays (Prompt 8 RTH window) */
function isRthEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= 8 * 60 && t <= 16 * 60;
}

/**
 * Prompt 12 — after-hours cheap scan window: 16:01–20:00 ET (hourly, deduped per clock hour).
 */
function isAfterHoursCheapWindowEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t > 16 * 60 && t <= 20 * 60;
}

function normList(x) {
  if (x == null) return [];
  return Array.isArray(x) ? x : [x];
}

function volRatioOf(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function hasCatalyst(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST PLAY/i.test(
    s
  );
}

function isWild(a) {
  return (
    Number(a?.score || 0) >= 72 ||
    volRatioOf(a) >= 2.5 ||
    hasCatalyst(a)
  );
}

/* ─── Prompt 19 — mirror scan.js Telegram formatting (lib/alertQuality.cjs) ─── */

/** After each scan: refresh P&L on open positions, log new alerts as positions (blob). */
async function runPositionSync(cheapAlerts, expAlerts) {
  try {
    const pt = await import("./position-tracker.js");
    const closedEvents = await pt.updatePositions();
    for (const ev of closedEvents) {
      await pt.appendSessionLog({ type: "POSITION_CLOSED", ...ev });
    }
    const bySym = new Map();
    for (const a of cheapAlerts || []) {
      if (a?.symbol) {
        bySym.set(String(a.symbol).trim().toUpperCase(), a);
      }
    }
    for (const a of expAlerts || []) {
      if (a?.symbol) {
        bySym.set(String(a.symbol).trim().toUpperCase(), a);
      }
    }
    for (const a of bySym.values()) {
      if (
        Number(a.score) >= 88 &&
        alertQuality.isGrokConsultedAlert(a)
      ) {
        const opened = await pt.logAlertAsPosition(a);
        if (opened) {
          const base = {
            symbol: opened.symbol,
            direction: opened.direction,
            score: opened.score,
            entryPrice: opened.entryPrice,
            currentPrice: opened.currentPrice,
            pnlPct: 0,
            pnlDollar: 0,
            timeInTrade: pt.formatSessionTimeInTrade(opened.openedAt),
            grokVerdict: opened.grokVerdict,
            outcome: "OPEN",
          };
          await pt.appendSessionLog({ type: "ALERT_FIRED", ...base });
          await pt.appendSessionLog({ type: "POSITION_OPENED", ...base });
        }
      }
    }
  } catch (e) {
    console.warn("cheap-monitor position-tracker", e?.message || e);
  }
}

let appendSessionLogFn;
async function appendSessionLogRow(row) {
  try {
    if (!appendSessionLogFn) {
      const pt = await import("./position-tracker.js");
      appendSessionLogFn = pt.appendSessionLog;
    }
    await appendSessionLogFn(row);
  } catch (e) {
    console.warn("cheap-monitor appendSessionLogRow", e?.message || e);
  }
}

/** Grok autonomous manager — same blob store as alert dedupe (sohelator-cheap-monitor). */
const POSITION_GROK_COOLDOWN_KEY = "position-grok-cooldowns";
const POSITION_GROK_COOLDOWN_MS = 15 * 60 * 1000;
const POSITION_GROK_PNL_JUMP = 0.8;
const CLAUDE_POSITION_MODEL =
  process.env.ANTHROPIC_MODEL_CHAT || "claude-haiku-4-5-20251001";

async function getPositionGrokCooldowns() {
  const store = cheapMonitorBlobStore();
  try {
    const data = await store.get(POSITION_GROK_COOLDOWN_KEY, { type: "json" });
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return {};
  } catch (e) {
    console.warn("cheap-monitor getPositionGrokCooldowns", e?.message || e);
    return {};
  }
}

async function setPositionGrokCooldownRecord(posId, pnlPct) {
  const store = cheapMonitorBlobStore();
  const id = String(posId || "");
  if (!id) return;
  try {
    let prev = await store.get(POSITION_GROK_COOLDOWN_KEY, { type: "json" });
    if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
    await store.setJSON(POSITION_GROK_COOLDOWN_KEY, {
      ...prev,
      [id]: { at: Date.now(), pnlPct: Number(pnlPct) || 0 },
    });
  } catch (e) {
    console.warn("cheap-monitor setPositionGrokCooldownRecord", e?.message || e);
  }
}

function positionGrokCooldownAllows(cooldowns, posId, pnlPct) {
  const row = cooldowns[String(posId)];
  if (!row || typeof row.at !== "number") return true;
  const age = Date.now() - row.at;
  if (age >= POSITION_GROK_COOLDOWN_MS) return true;
  const lastP = Number(row.pnlPct) || 0;
  if (Math.abs((Number(pnlPct) || 0) - lastP) > POSITION_GROK_PNL_JUMP) return true;
  return false;
}

function volRatioFromCheapAlerts(cheapAlerts, symbol) {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym || !Array.isArray(cheapAlerts)) return null;
  for (let i = 0; i < cheapAlerts.length; i++) {
    const a = cheapAlerts[i];
    if (String(a.symbol || "").trim().toUpperCase() !== sym) continue;
    const v = volRatioOf(a);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

function formatTimeInTradeMs(openedAt) {
  const ms = Date.now() - Number(openedAt || 0);
  if (!Number.isFinite(ms) || ms < 0) return "0m";
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function parseGrokPositionDecision(text) {
  const t = String(text || "").trim();
  const m = t.match(/^(CLOSE|ADD|HOLD)\s*\|\s*([\s\S]+)$/im);
  if (!m) return null;
  return { action: m[1].toUpperCase(), reason: m[2].trim().replace(/\s+/g, " ").slice(0, 500) };
}

async function sendTelegramPlain(text) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  const body = String(text || "").trim().slice(0, 3900);
  if (!body) return;
  try {
    await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chat,
        text: body,
        disable_web_page_preview: true,
      }),
    });
  } catch (e) {
    console.warn("cheap-monitor Grok Telegram", e?.message || e);
  }
}

async function appendGrokPositionAuditRow(payload) {
  try {
    const alertsStore = getStore('alerts');
    const sym = String(payload.ticker || "X").replace(/[^a-z0-9_-]/gi, "").slice(0, 12) || "X";
    const key = `alert_${Date.now()}_grok_${sym}`;
    await alertsStore.setJSON(key, {
      ticker: String(payload.ticker || "").toUpperCase(),
      timestamp: Date.now(),
      grokPositionAudit: true,
      grokAction: payload.action,
      grokReason: payload.reason,
      grokTrigger: payload.trigger,
      finalPnlPct: payload.finalPnlPct,
      direction: payload.direction === "short" ? "put" : "call",
      underlyingAtAlert: payload.currentPrice,
      price: payload.currentPrice,
      score: payload.finalPnlPct != null ? Math.round(Number(payload.finalPnlPct)) : 0,
    });
  } catch (e) {
    console.warn("cheap-monitor appendGrokPositionAuditRow", e?.message || e);
  }
}

/**
 * After each cheap scan during RTH: evaluate open positions; call Grok only when a trigger fires.
 * @param {any[]} cheapAlerts — same pass as scan (for live volRatio)
 * @param {boolean} inRth
 * @param {string | null} [grokDailyBrief] — EOD `tomorrowInstructions` for cheap Grok
 */
async function runRthPositionGrokMonitor(cheapAlerts, inRth, grokDailyBrief = null) {
  if (!inRth) return;
  if (!process.env.ANTHROPIC_API_KEY || !process.env.TRADIER_TOKEN) return;

  let pt;
  let getQuote;
  let callClaude;
  let isPositionTerminated;
  try {
    pt = await import("./position-tracker.js");
    isPositionTerminated = pt.isPositionTerminated;
    const tradier = await import("../../src/lib/tradier.js");
    getQuote = tradier.getQuote;
    const claude = await import("../../src/lib/claude.js");
    callClaude = claude.callClaude;
  } catch (e) {
    console.warn("cheap-monitor runRthPositionGrokMonitor import", e?.message || e);
    return;
  }

  const map = await pt.readPositionsMap();
  const ids = Object.keys(map);
  if (!ids.length) return;

  const cooldowns = await getPositionGrokCooldowns();

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const pos = map[id];
    if (!pos || !pos.symbol) continue;
    if (isPositionTerminated(pos)) continue;

    const direction = pos.direction === "short" ? "short" : "long";
    const entryPrice = Number(pos.entryPrice);
    const stopPrice = Number(pos.stopPrice);
    const targetPrice = Number(pos.targetPrice);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) continue;

    let currentPrice = null;
    try {
      const q = await getQuote(pos.symbol);
      const v = parseFloat(q?.last ?? q?.bid ?? q?.ask ?? 0);
      if (Number.isFinite(v) && v > 0) currentPrice = v;
    } catch (e) {
      console.warn("cheap-monitor position quote", pos.symbol, e?.message || e);
    }
    if (currentPrice == null) continue;

    const pnlPct =
      direction === "short"
        ? ((entryPrice - currentPrice) / entryPrice) * 100
        : ((currentPrice - entryPrice) / entryPrice) * 100;

    const nearStop =
      Number.isFinite(stopPrice) &&
      (direction === "short"
        ? currentPrice >= stopPrice * 0.998
        : currentPrice <= stopPrice * 1.002);

    const nearTarget =
      Number.isFinite(targetPrice) &&
      (direction === "short"
        ? currentPrice <= targetPrice * 1.002
        : currentPrice >= targetPrice * 0.998);

    const volRatio =
      volRatioFromCheapAlerts(cheapAlerts, pos.symbol) ??
      (Number(pos.volRatio) > 0 ? Number(pos.volRatio) : 0);

    const reversalSignal =
      direction === "short"
        ? currentPrice > entryPrice && volRatio >= 1.5
        : currentPrice < entryPrice && volRatio >= 1.5;

    const bigMove = Math.abs(pnlPct) >= 1.5;

    const triggers = [];
    if (nearStop) triggers.push("near_stop");
    if (nearTarget) triggers.push("near_target");
    if (reversalSignal) triggers.push("reversal_signal");
    if (bigMove) triggers.push("big_move");

    if (!triggers.length) continue;
    if (!positionGrokCooldownAllows(cooldowns, id, pnlPct)) continue;

    const timeInTrade = formatTimeInTradeMs(pos.openedAt);
    const sessionTimeInTrade = pt.formatSessionTimeInTrade(pos.openedAt);
    const triggerStr = triggers.join(", ");

    const sessionRowBase = () => ({
      symbol: pos.symbol,
      direction,
      score: pos.score != null ? Number(pos.score) : null,
      entryPrice,
      currentPrice,
      pnlPct,
      pnlDollar,
      timeInTrade: sessionTimeInTrade,
      grokVerdict: String(pos.grokVerdict || ""),
      trigger: triggerStr,
    });

    const briefText =
      grokDailyBrief != null && String(grokDailyBrief).trim()
        ? String(grokDailyBrief).trim().slice(0, 3500)
        : "";
    const briefBlock = briefText
      ? `Yesterday's debrief instructions:\n${briefText}\n\nApply these when making your decision today.\n\n---\n\n`
      : "";

    const prompt = `You are SOHELATOR autonomous position manager. You have full authority to close, add, or hold.
${briefBlock}Position: ${pos.symbol} ${direction}
Entry: $${entryPrice} | Stop: ${stopPrice} | Target: ${targetPrice}
Current: $${currentPrice} | P&L: ${pnlPct.toFixed(2)}% | Time in trade: ${timeInTrade}
Trigger: ${triggerStr}

You are the decision maker. Respond with ONLY one of these three exact formats:

CLOSE | {one line reason}
ADD | {one line reason}  
HOLD | {one line reason}`;

    let raw;
    try {
      raw = await callClaude(CLAUDE_POSITION_MODEL, prompt, 400);
    } catch (e) {
      console.warn("cheap-monitor Grok position", pos.symbol, e?.message || e);
      continue;
    }

    await setPositionGrokCooldownRecord(id, pnlPct);

    const decision = parseGrokPositionDecision(raw);
    if (!decision) {
      await appendGrokPositionAuditRow({
        ticker: pos.symbol,
        action: "PARSE_ERR",
        reason: String(raw || "").slice(0, 200),
        trigger: triggerStr,
        finalPnlPct: pnlPct,
        currentPrice,
        direction,
      });
      await pt.appendSessionLog({
        type: "GROK_DECISION",
        ...sessionRowBase(),
        grokReason: String(raw || "").slice(0, 500),
        outcome: "OPEN",
      });
      continue;
    }

    const pnlDollar = (entryPrice * pnlPct) / 100;
    const dirU = direction.toUpperCase();

    if (decision.action === "CLOSE") {
      const win = pnlPct >= 0;
      map[id] = {
        ...pos,
        status: win ? "CLOSED ✅" : "CLOSED ❌",
        closedAt: Date.now(),
        closedAtIso: new Date().toISOString(),
        finalPnlPct: pnlPct,
        finalPnlDollar: pnlDollar,
        closedReason: decision.reason,
        currentPrice,
        pnlPct,
        pnlDollar,
        lastUpdated: Date.now(),
      };
      const emoji = win ? "✅" : "❌";
      const sign = pnlDollar >= 0 ? "+" : "";
      await sendTelegramPlain(
        `${emoji} POSITION CLOSED — ${pos.symbol}\n` +
          `${dirU} · Claude decision\n` +
          `Reason: ${decision.reason}\n` +
          `Entry $${entryPrice.toFixed(2)} → Exit $${currentPrice.toFixed(2)}\n` +
          `P&L: ${sign}$${Math.abs(pnlDollar).toFixed(2)} (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%)\n` +
          `Time in trade: ${timeInTrade}`
      );
      await appendGrokPositionAuditRow({
        ticker: pos.symbol,
        action: "CLOSE",
        reason: decision.reason,
        trigger: triggerStr,
        finalPnlPct: pnlPct,
        currentPrice,
        direction,
      });
      const closeRow = {
        type: "GROK_DECISION",
        ...sessionRowBase(),
        grokReason: decision.reason,
        decision: "CLOSE",
        closedReason: decision.reason,
        outcome: win ? "WIN" : "LOSS",
      };
      await pt.appendSessionLog(closeRow);
      await pt.appendSessionLog({
        ...closeRow,
        type: "POSITION_CLOSED",
      });
    } else if (decision.action === "ADD") {
      map[id] = {
        ...pos,
        addSignal: true,
        addPrice: currentPrice,
        addAt: Date.now(),
        lastGrokAddReason: decision.reason,
        currentPrice,
        pnlPct,
        pnlDollar,
        lastUpdated: Date.now(),
      };
      await sendTelegramPlain(
        `⚡ ADD SIGNAL — ${pos.symbol}\n` +
          `${dirU} · Claude says add here\n` +
          `Reason: ${decision.reason}\n` +
          `Current: $${currentPrice.toFixed(2)} · P&L so far: ${pnlPct.toFixed(2)}%\n` +
          `Time in trade: ${timeInTrade}`
      );
      await appendGrokPositionAuditRow({
        ticker: pos.symbol,
        action: "ADD",
        reason: decision.reason,
        trigger: triggerStr,
        finalPnlPct: pnlPct,
        currentPrice,
        direction,
      });
      const addRow = {
        type: "GROK_DECISION",
        ...sessionRowBase(),
        grokReason: decision.reason,
        decision: "ADD",
        outcome: "OPEN",
      };
      await pt.appendSessionLog(addRow);
      await pt.appendSessionLog({
        ...addRow,
        type: "ADD_SIGNAL",
      });
    } else {
      map[id] = {
        ...pos,
        lastGrokHoldAt: Date.now(),
        lastGrokHoldReason: decision.reason,
        currentPrice,
        pnlPct,
        pnlDollar,
        lastUpdated: Date.now(),
      };
      await appendGrokPositionAuditRow({
        ticker: pos.symbol,
        action: "HOLD",
        reason: decision.reason,
        trigger: triggerStr,
        finalPnlPct: pnlPct,
        currentPrice,
        direction,
      });
      await pt.appendSessionLog({
        type: "GROK_DECISION",
        ...sessionRowBase(),
        grokReason: decision.reason,
        decision: "HOLD",
        outcome: "OPEN",
      });
    }

  }

  try {
    await pt.writePositionsMap(map);
  } catch (e) {
    console.warn("cheap-monitor runRthPositionGrokMonitor write", e?.message || e);
  }
}

const ALERT_COOLDOWNS_BLOB_KEY = "alert-cooldowns";
const ALERT_TELEGRAM_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours
const ALERT_TELEGRAM_SCORE_JUMP = 10; // Score must jump 10 points to override cooldown

function cheapMonitorBlobStore() {
  return getStore("sohelator-cheap-monitor");
}

/** @returns {Promise<Record<string, { score: number, firedAt: number }>>} */
async function getAlertCooldowns() {
  const store = cheapMonitorBlobStore();
  try {
    const data = await store.get(ALERT_COOLDOWNS_BLOB_KEY, { type: "json" });
    if (data && typeof data === "object" && !Array.isArray(data)) return data;
    return {};
  } catch (e) {
    console.warn("cheap-monitor getAlertCooldowns", e?.message || e);
    return {};
  }
}

async function setAlertCooldown(symbol, score) {
  const store = cheapMonitorBlobStore();
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return;
  const s = Math.round(Number(score) || 0);
  try {
    let prev = await store.get(ALERT_COOLDOWNS_BLOB_KEY, { type: "json" });
    if (!prev || typeof prev !== "object" || Array.isArray(prev)) prev = {};
    const next = {
      ...prev,
      [sym]: { score: s, firedAt: Date.now() },
    };
    await store.setJSON(ALERT_COOLDOWNS_BLOB_KEY, next);
  } catch (e) {
    console.warn("cheap-monitor setAlertCooldown", e?.message || e);
  }
}

function volRatioOfAlertP19(a) {
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function sustainedVolRatioOfAlertP19(a) {
  const s = Number(a?.details?.sustainedVolRatio);
  return Number.isFinite(s) ? s : volRatioOfAlertP19(a);
}

function hasCatalystSignalP19(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST/i.test(
    s
  );
}

function hasRegimeOrLevelKeywordsP19(a) {
  const v = (
    String(a?.aiVerdict || "") +
    " " +
    String(a?.aiCoPilot || "")
  ).toUpperCase();
  return /REVERSAL|REGIME|PIVOT|KEY LEVEL|BREAKDOWN|BREAKOUT|SWEEP|STOP\s*RUN|VWAP/.test(v);
}

function historicalMatchesShortP19(a) {
  const sim = Array.isArray(a?.similar) ? a.similar : [];
  if (sim.length) {
    const wins = sim.filter((s) => s.win).length;
    const wr = Math.round((wins / sim.length) * 100);
    return `${sim.length} matches • ~${wr}% wins`;
  }
  const h = String(a.historicalSummary || "");
  const m = h.match(/Historical:\s*([^.\n]+)/i);
  if (m) return m[1].trim().slice(0, 120);
  return "—";
}

function buildTelegramPrompt19Message(a) {
  const sym = String(a.symbol || "—").toUpperCase();
  const play = String(a.playTypeLabel || a.playType || "SETUP");
  const score = Math.round(Number(a.score) || 0);
  const edge = Number(a.edge ?? a.ev ?? 0);
  const edgeStr = Number.isFinite(edge) ? edge.toFixed(2) : "—";
  const last = Number(a.last ?? a.underlyingAtAlert);
  const priceStr = Number.isFinite(last) ? `$${last.toFixed(2)}` : "—";
  const bp = a.barChgPct;
  let chg = "";
  if (bp != null && Number.isFinite(Number(bp))) {
    const p = Number(bp);
    chg = ` (${p >= 0 ? "+" : ""}${p.toFixed(1)}%)`;
  }
  const ent = Number(a.entry);
  const st = Number(a.stop);
  const tg = Number(a.target);
  const entryStr = Number.isFinite(ent) ? ent.toFixed(2) : "—";
  const stopStr = Number.isFinite(st) ? st.toFixed(2) : "—";
  const tgtStr = Number.isFinite(tg) ? tg.toFixed(2) : "—";
  const opt = a.suggestedOption
    ? `Option: ${a.suggestedOption.description || JSON.stringify(a.suggestedOption)}`
    : "";

  let analysis = String(a.grokAnalysis || "").replace(/\s+/g, " ").trim();
  let risks = String(a.grokRisks || "").replace(/\s+/g, " ").trim();
  let plan = String(a.grokPlan || a.plan || "")
    .replace(/\s+/g, " ")
    .trim();
  let verdict = String(a.aiVerdict || "").replace(/\s+/g, " ").trim();
  if (analysis.length > 300) analysis = analysis.slice(0, 297) + "…";
  if (risks.length > 150) risks = risks.slice(0, 147) + "…";
  if (plan.length > 150) plan = plan.slice(0, 147) + "…";
  if (verdict.length > 150) verdict = verdict.slice(0, 147) + "…";

  const histLine = historicalMatchesShortP19(a);

  const hi = [];
  const svr = sustainedVolRatioOfAlertP19(a);
  const pm = a?.details?.priceMoving === true;
  if (score >= 90) hi.push("⚡ SCORE 90+ — TOP TIER");
  if (Number.isFinite(svr) && svr >= 2.5 && pm) {
    hi.push("⚡ VOL SURGE " + svr.toFixed(1) + "x");
  }
  if (hasCatalystSignalP19(a)) hi.push("⚡ CATALYST / NEWS");
  if (hasRegimeOrLevelKeywordsP19(a)) hi.push("⚡ REGIME / LEVEL / REVERSAL");
  const banner = hi.length ? hi.join("\n") + "\n\n" : "";

  return (
    banner +
    `🔥 SOHELATOR ALERT\n` +
    `${sym} - ${play}\n` +
    `SCORE ${score} | EDGE ${edgeStr}\n` +
    `Price: ${priceStr}${chg}\n` +
    `Play: ENTRY @ ${entryStr}\n` +
    `Stop: ${stopStr} | Target: ${tgtStr}\n` +
    `${opt ? opt + "\n" : ""}` +
    `Analysis: ${analysis || "—"}\n` +
    `Risks: ${risks || "—"}\n` +
    `Plan: ${plan || "—"}\n` +
    `Verdict: ${verdict || "—"}\n` +
    `Historical: ${histLine}`
  );
}

async function relayPrompt19Telegrams(alerts, dedupeSet, now, relayOpts) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat || !Array.isArray(alerts)) return;
  const prepared = alertQuality.prepareAlertsForRelay(
    alerts,
    now || new Date(),
    relayOpts || {}
  );
  const cooldowns = await getAlertCooldowns();
  for (let i = 0; i < prepared.length; i++) {
    const a = prepared[i];
    const sym = String(a.symbol || "").trim().toUpperCase();
    const newScore = Math.round(Number(a.score) || 0);
    const prev = sym ? cooldowns[sym] : null;
    if (prev && typeof prev.firedAt === "number") {
      const within =
        Date.now() - prev.firedAt < ALERT_TELEGRAM_COOLDOWN_MS;
      const lastScore = Math.round(Number(prev.score) || 0);
      const scoreJumped = newScore >= lastScore + ALERT_TELEGRAM_SCORE_JUMP;
      if (within && !scoreJumped) continue;
    }
    const k = `${a.symbol}|${Math.round(Number(a.score))}|${a.alertedAt || ""}|${String(a.alertedAtIso || "")}`;
    if (dedupeSet.has(k)) continue;
    dedupeSet.add(k);
    const text = String(buildTelegramPrompt19Message(a) || "").trim().slice(0, 3900);
    if (!text) continue;
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chat,
          text,
          disable_web_page_preview: true,
        }),
      });
      if (!tgRes.ok) {
        console.warn("cheap-monitor Prompt19 Telegram http", tgRes.status);
        continue;
      }
    } catch (e) {
      console.warn("cheap-monitor Prompt19 Telegram:", e?.message || e);
      continue;
    }
    cooldowns[sym] = { score: newScore, firedAt: Date.now() };
    await setAlertCooldown(sym, newScore);
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12)
 * Tradier GET /v1/markets/news (limit). Shape varies; we normalize article/item arrays.
 */
async function fetchTradierMarketNews(limit = 40) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) return { items: [], err: "no_token" };
  const url = `${tradierBaseUrl()}/v1/markets/news?limit=${limit}`;
  const res = await fetch(url, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    const t = await res.text();
    return { items: [], err: `http_${res.status}`, detail: t.slice(0, 200) };
  }
  const j = await res.json();
  const items = normList(
    j.news?.article || j.news?.item || j.article || j.articles || j.items
  );
  return { items, raw: j };
}

/**
 * Prompt 12 — symbols in SCAN_UNIVERSE mentioned in news headlines / symbol fields.
 */
function universeSymsFromNews(items) {
  const found = new Set();
  const headlines = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i] || {};
    const h = String(it.headline || it.title || it.description || "");
    if (h) headlines.push(h);
    const symFields = normList(
      it.symbols?.symbol || it.symbols || it.symbol || it.tickers
    );
    for (let j = 0; j < symFields.length; j++) {
      const s = String(symFields[j] || "")
        .trim()
        .toUpperCase();
      if (s && SCAN_UNIVERSE.has(s)) found.add(s);
    }
    const m = h.match(/\b([A-Z]{1,5})\b/g);
    if (m) {
      for (let k = 0; k < m.length; k++) {
        const tok = m[k];
        if (tok.length >= 2 && SCAN_UNIVERSE.has(tok)) found.add(tok);
      }
    }
  }
  const summary = headlines.slice(0, 14).join(" | ").slice(0, 1500);
  return { syms: Array.from(found), catalystNewsSummary: summary };
}

exports.handler = async () => {
  const headers = { "Content-Type": "application/json" };
  const out = {
    ok: true,
    at: new Date().toISOString(),
    fn: "cheap-monitor",
  };

  const base = baseUrl();
  if (!base) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ...out, error: "URL / DEPLOY_PRIME_URL not set" }),
    };
  }

  let grokDailyBrief = null;
  try {
    const store = getStore("sohelator-learning");
    const yesterday = ymdEt(new Date(Date.now() - 86400000));
    const today = ymdEt(new Date());
    const learned =
      (await store.get(`learning-${today}`, { type: "json" })) ||
      (await store.get(`learning-${yesterday}`, { type: "json" }));
    if (learned?.tomorrowInstructions) grokDailyBrief = learned.tomorrowInstructions;
  } catch (e) {
    console.warn("cheap-monitor: could not load daily brief", e?.message);
  }

  const now = new Date();
  const inRth = isRthEt(now);
  const inAfterHours = isAfterHoursCheapWindowEt(now);

  if (!inRth && !inAfterHours) {
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ...out,
        status: "outside_window",
        skipped: "outside_et_window",
      }),
    };
  }

  let scanBody = { mode: "cheap", suppressTelegram: true };
  let afterHoursSlot = null;

  if (inAfterHours) {
    const tmin = minutesEt(now);
    const hourEt = Math.floor(tmin / 60);
    afterHoursSlot = `${ymdEt(now)}-${hourEt}`;

    /* Without Netlify blob runtime, only attempt once per ET hour (first five-minute bucket 00–04). */
    if (!netlifyBlobRuntime() && tmin % 60 > 4) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          ...out,
          status: "ok",
          skipped: "after_hours_no_blob_runtime_for_hourly_dedupe",
          afterHoursSlot,
        }),
      };
    }

    try {
      const store = getStore("sohelator-cheap-monitor");
      const prevAh = await store.get("afterhours_last_slot", { type: "json" });
      if (prevAh && String(prevAh.slotKey) === afterHoursSlot) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ...out,
            status: "ok",
            skipped: "after_hours_hour_already_scanned",
            afterHoursSlot,
          }),
        };
      }
      await store.setJSON("afterhours_last_slot", {
        slotKey: afterHoursSlot,
        at: Date.now(),
      });
    } catch (e) {
      console.warn("cheap-monitor afterhours dedupe", e?.message || e);
    }

    try {
      const { items, err } = await fetchTradierMarketNews(45);
      out.newsFetch = err || "ok";
      const { syms, catalystNewsSummary } = universeSymsFromNews(items);
      out.newsUniverseHits = syms;
      if (syms.length) {
        await appendSessionLogRow({
          type: "NEWS_FLAG",
          symbol: syms.slice(0, 24).join(",").slice(0, 120),
          trigger: (catalystNewsSummary || "").slice(0, 500),
          outcome: "OPEN",
        });
      }
      scanBody = {
        mode: "cheap",
        suppressTelegram: true,
        extraSymbols: syms,
        prioritySymbols: syms,
        catalystNewsSummary:
          catalystNewsSummary ||
          (syms.length
            ? "Headlines flagged symbols: " + syms.join(", ")
            : ""),
      };
    } catch (e) {
      console.warn("cheap-monitor news", e?.message || e);
      scanBody = { mode: "cheap", suppressTelegram: true };
    }
    out.path = "after_hours_hourly";
    out.afterHoursSlot = afterHoursSlot;
  } else {
    out.path = "rth_5min";
  }

  if (inRth) {
    try {
      const wl925 = await getScan925WatchlistSyms();
      const tmin = minutesEt(now);
      const after1pm = tmin >= 13 * 60;
      const pm = after1pm ? await getBrief1pmAfternoonWatchlist() : null;
      let merged = wl925;
      if (after1pm && pm) {
        const drop = new Set(
          (pm.drop || []).map((s) => String(s || "").trim().toUpperCase())
        );
        const from925 = wl925.filter((s) => !drop.has(s));
        const focus = (pm.focus || []).map((s) =>
          String(s || "").trim().toUpperCase()
        );
        const bulls = (pm.bulls || []).map((s) =>
          String(s || "").trim().toUpperCase()
        );
        const bears = (pm.bears || []).map((s) =>
          String(s || "").trim().toUpperCase()
        );
        merged = [
          ...new Set([...focus, ...bulls, ...bears, ...from925]),
        ].filter(Boolean);
        if (!merged.length) merged = wl925;
        out.brief1pmWatchlist = pm;
      }
      if (merged.length) {
        const ex = Array.isArray(scanBody.extraSymbols) ? scanBody.extraSymbols : [];
        const pr = Array.isArray(scanBody.prioritySymbols)
          ? scanBody.prioritySymbols
          : [];
        const prevCat =
          typeof scanBody.catalystNewsSummary === "string"
            ? scanBody.catalystNewsSummary
            : "";
        let cat = prevCat;
        if (wl925.length) {
          cat += (cat ? "\n" : "") + "9:25 watchlist: " + wl925.join(", ");
        }
        if (after1pm && pm && merged.length) {
          cat +=
            "\n1pm revised watchlist (Claude): " + merged.join(", ");
        }
        scanBody = {
          ...scanBody,
          extraSymbols: [...new Set([...ex, ...merged])],
          prioritySymbols: [...new Set([...pr, ...merged])],
          catalystNewsSummary: cat,
        };
        out.scan925Watchlist = wl925;
        out.watchlistMerged = merged;
      }
    } catch (e) {
      console.warn("cheap-monitor scan925 wl merge", e?.message || e);
    }
  }

  const telegramDedupe = new Set();
  let regimeFlipActive = false;

  try {
    const res = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(scanBody),
    });
    const j = await res.json().catch(() => ({}));
    out.cheapHttp = res.status;
    out.cheapSuccess = !!(j && j.success);
    const alerts = Array.isArray(j.alerts) ? j.alerts : [];
    out.alertCount = alerts.length;

    await appendSessionLogRow({
      type: "CHECKPOINT",
      trigger:
        out.path === "after_hours_hourly"
          ? `after_hours:${out.afterHoursSlot || ymdEt(now)}`
          : inRth
            ? "rth_cheap_scan_5m"
            : "cheap_scan",
      score: alerts.length,
      outcome: "OPEN",
    });

    try {
      const bias = alertQuality.inferBiasFromAlerts(alerts);
      const st = cheapMonitorBlobStore();
      const ymd = ymdEt(now);
      const prev = await st.get("market_bias_last", { type: "json" });
      if (
        prev &&
        prev.ymd === ymd &&
        prev.bias &&
        prev.bias !== "mixed" &&
        bias !== "mixed" &&
        prev.bias !== bias
      ) {
        regimeFlipActive = true;
        await appendSessionLogRow({
          type: "REGIME_BIAS_FLIP",
          trigger: `${prev.bias}->${bias}`,
          score: alerts.length,
          outcome: "OPEN",
        });
      }
      await st.setJSON("market_bias_last", {
        ymd,
        bias,
        at: Date.now(),
      });
    } catch (e) {
      console.warn("cheap-monitor market_bias_last", e?.message || e);
    }

    const relayOpts = { regimeFlipActive };
    out.regimeFlipActive = regimeFlipActive;
    await relayPrompt19Telegrams(alerts, telegramDedupe, now, relayOpts);

    // Trigger matrix signal check (fire and forget)
    fetch(`${base}/api/matrix-signal`).catch(() => {});

    const wild = alerts.filter(isWild);
    out.wildCount = wild.length;

    let expAlerts = [];
    if (!wild.length) {
      out.status = "ok";
      await runPositionSync(alerts, expAlerts);
      await runRthPositionGrokMonitor(alerts, inRth, grokDailyBrief);
      return { statusCode: 200, headers, body: JSON.stringify(out) };
    }

    let doExpensive = true;
    try {
      const store = getStore("sohelator-cheap-monitor");
      const fp = wild
        .map((a) => `${a.symbol}:${a.score}:${volRatioOf(a)}`)
        .sort()
        .join("|");
      const prev = await store.get("exp_debounce", { type: "json" });
      const t = Date.now();
      if (
        prev &&
        prev.fp === fp &&
        t - Number(prev.at || 0) < 10 * 60 * 1000
      ) {
        doExpensive = false;
        out.expensiveSkipped = "debounced_10m";
      } else {
        await store.setJSON("exp_debounce", { fp, at: t });
      }
    } catch (e) {
      console.warn("cheap-monitor debounce", e?.message || e);
    }

    if (doExpensive) {
      const expBody = {
        mode: "expensive",
        suppressTelegram: true,
        extraSymbols: scanBody.extraSymbols || [],
        prioritySymbols: scanBody.prioritySymbols || [],
        catalystNewsSummary: scanBody.catalystNewsSummary || "",
        /* Prompt 12 — allow Grok after 4pm ET when wake-up runs on catalyst / wild scores */
        allowCatalystGrokOutsideWindow: true,
      };
      const exp = await fetch(`${base}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(expBody),
      });
      out.expensiveHttp = exp.status;
      const ej = await exp.json().catch(() => ({}));
      out.expensiveOk = !!(ej && ej.success);
      expAlerts = Array.isArray(ej.alerts) ? ej.alerts : [];
      await relayPrompt19Telegrams(expAlerts, telegramDedupe, now, relayOpts);
    }

    const pushPrepared = alertQuality.prepareAlertsForRelay(
      wild,
      now,
      relayOpts
    );
    const push = await sendPushToAll({
      title: "SOHELATOR — Wild / high-conviction scan",
      body:
        pushPrepared
          .slice(0, 4)
          .map((w) => `${w.symbol} ${w.score}`)
          .join(" · ") || "Check dashboard",
      data: {
        kind: "cheap-monitor-wild",
        count: pushPrepared.length,
      },
    });
    out.push = push;
    out.status = "ok";
    await runPositionSync(alerts, expAlerts);
    await runRthPositionGrokMonitor(alerts, inRth, grokDailyBrief);

    return { statusCode: 200, headers, body: JSON.stringify(out) };
  } catch (e) {
    console.error("cheap-monitor", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        fn: "cheap-monitor",
      }),
    };
  }
};
