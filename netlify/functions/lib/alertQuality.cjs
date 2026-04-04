"use strict";

/**
 * Shared rules: Telegram / push only for AI co-pilot–enriched (Claude), high-signal setups.
 * Opening burst (9:30–9:45 ET): at most 2 names after sort (no global daily cap).
 */

const OPEN_START_MIN = 9 * 60 + 30;
const OPEN_BURST_END_MIN = 9 * 60 + 45;

/** Reject placeholder / error text from scan `grokAnalysis` (legacy field name). */
const AI_ANALYSIS_BAD =
  /Grok batch:|AI batch:|could not parse|unavailable|Claude unavailable|Rules edge\b/i;

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

function isOpeningBurstWindowEt(d) {
  if (!isWeekdayEt(d)) return false;
  const t = minutesEt(d);
  return t >= OPEN_START_MIN && t < OPEN_BURST_END_MIN;
}

function volRatioOf(a) {
  const s = Number(a?.details?.sustainedVolRatio);
  if (Number.isFinite(s) && s > 0) return s;
  return Number(a?.details?.volRatio ?? a?.volRatio ?? 0);
}

function hasCatalystSignal(a) {
  const s = JSON.stringify(a || {}).toUpperCase();
  return /CATALYST|EARNINGS|FDA|NEWS|\bGAP\b|UPGRADE|DOWNGRADE|BREAKING|MERGER|GUIDANCE|HIGH-PROBABILITY CATALYST/i.test(
    s
  );
}

/** Must have score, Claude analysis, and levels — volume alone never qualifies. */
function hasTradeableQuality(a) {
  const sc = Number(a.score) || 0;
  const hasHighScore = sc >= 85;
  const hasClaudeAnalysis = isGrokConsultedAlert(a);
  const hasValidLevels =
    a.entry &&
    a.stop &&
    a.target &&
    Number(a.entry) > 0 &&
    Number(a.stop) > 0 &&
    Number(a.target) > 0;
  return hasHighScore && hasClaudeAnalysis && hasValidLevels;
}

function passesTelegramExtras(a) {
  const ent = Number(a.entry);
  const st = Number(a.stop);
  const tg = Number(a.target);
  if (!Number.isFinite(ent) || !Number.isFinite(st) || !Number.isFinite(tg)) {
    return false;
  }
  const opt = String(a.suggestedOption?.description || "");
  if (!opt || opt.includes("undefined") || opt.length < 10) return false;
  return true;
}

function isGrokConsultedAlert(a) {
  if (!a || typeof a !== "object") return false;
  const analysis = String(a.grokAnalysis || "").trim();
  if (analysis.length < 90) return false;
  if (AI_ANALYSIS_BAD.test(analysis)) return false;
  const risks = String(a.grokRisks || "").trim();
  const plan = String(a.grokPlan || a.plan || "").trim();
  if (risks.length < 25 || plan.length < 25) return false;
  return true;
}

/**
 * @param {Date} now
 * @param {{ regimeFlipActive?: boolean }} [opts]
 */
function minScoreForTelegram(now, opts) {
  const d = now instanceof Date ? now : new Date(now);
  if (opts && opts.regimeFlipActive) return 85;
  if (isOpeningBurstWindowEt(d)) return 85;
  return 88;
}

function inferBiasFromAlerts(alerts) {
  const top = [...(alerts || [])]
    .filter((a) => Number(a.score) >= 70)
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, 5);
  if (!top.length) return "mixed";
  let longs = 0;
  let shorts = 0;
  for (const a of top) {
    if (String(a.direction || "").toLowerCase() === "short") shorts++;
    else longs++;
  }
  if (longs >= shorts + 2) return "up";
  if (shorts >= longs + 2) return "down";
  return "mixed";
}

/**
 * @param {any[]} alerts
 * @param {Date} now
 * @param {{ regimeFlipActive?: boolean, skipOpeningTopN?: boolean }} [options]
 */
function prepareAlertsForRelay(alerts, now, options) {
  const d = now instanceof Date ? now : new Date(now);
  const opts = options || {};
  const minScore = minScoreForTelegram(d, opts);
  let list = (alerts || []).filter((a) => {
    const sc = Number(a.score) || 0;
    return sc >= minScore && hasTradeableQuality(a);
  });
  list.sort((a, b) => Number(b.score) - Number(a.score));
  if (isOpeningBurstWindowEt(d) && !opts.skipOpeningTopN) {
    list = list.slice(0, 2);
  }
  return list;
}

module.exports = {
  isGrokConsultedAlert,
  hasTradeableQuality,
  passesTelegramExtras,
  minScoreForTelegram,
  inferBiasFromAlerts,
  prepareAlertsForRelay,
  isOpeningBurstWindowEt,
  minutesEt,
  isWeekdayEt,
  volRatioOf,
  hasCatalystSignal,
};
