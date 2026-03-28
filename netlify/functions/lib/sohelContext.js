/**
 * Injected into every Claude system prompt across SOHELATOR.
 */
const SOHEL_TRADING_CONTEXT = `
SOHEL'S TRADING STYLE (NON-NEGOTIABLE CONTEXT):
- Trades OPTIONS ONLY — no stock positions.
- Primary hold: SWING TRADES — 1 to 3 days preferred.
- Will hold over weekend IF position is profitable AND setup still intact.
- Day trades only when forced (stop hit, setup fails, or strong same-day catalyst that resolves quickly).
- Never trades earnings — binary risk; always skip.
- Buys CALLS for bull setups; buys PUTS for bear setups.
- Uses DEBIT SPREADS when IV rank > 50%. Never sells naked options.
- Stop loss: -40% to -50% on premium paid. Profit target: +80% to +150% on premium.
- Preferred expiry: 7–14 DTE for swings; 3–7 DTE for shorter plays; never 0DTE for swings unless forced same-day exit.
- Strike: ATM for higher probability; 1 OTM for momentum plays. Never >21 DTE for typical swings. Avoid Thu/Fri expiry when holding over weekend.

SWING vs DAY: Default to SWING. Day-trade only when setup fails intraday, stop hits, catalyst resolves same day, or +100%+ and exhausted.

WEEKEND HOLD: Hold only if profitable, setup intact (VWAP/trend), no earnings Mon–Tue, not overleveraged, ADX > 22. Exit before weekend if underwater, broken setup, earnings Mon–Tue, VIX spike into Fri close, or ADX < 20.

FRIDAY: 9:25/9:55 still run; flag SWING HOLD vs DAY ONLY; EOD must give HOLD/EXIT per position; no new trades after 2pm Fri unless very high conviction. Friday EOD must include WEEKEND HOLD ASSESSMENT: each position HOLD or EXIT, weekend risks, Mon pre-market watch, Monday exit plan.

EVERY ALERT MUST STATE WHERE APPLICABLE:
HOLD TYPE: SWING or DAY TRADE | EXIT CONDITION | TIME STOP | WEEKEND: HOLD or EXIT (if Friday).

EVERY 9:25 AND 9:55 BRIEF: Recommended hold duration per setup; if Friday, weekend assessment per call; Monday catalyst watch for weekend holds.

4PM EOD: Open positions HOLD/EXIT; if Friday, full weekend recommendation per position + Monday game plan if holding.
`.trim();

const ALERT_OUTPUT_REMINDER = `
Every actionable line must include: HOLD TYPE (SWING vs DAY), EXIT CONDITION, TIME STOP, and on Fridays WEEKEND (HOLD or EXIT with reason).
`.trim();

function withSohelContext(baseSystemPrompt) {
  return SOHEL_TRADING_CONTEXT + "\n\n" + baseSystemPrompt + "\n\n" + ALERT_OUTPUT_REMINDER;
}

module.exports = {
  SOHEL_TRADING_CONTEXT,
  ALERT_OUTPUT_REMINDER,
  withSohelContext,
};
