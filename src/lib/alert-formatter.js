/**
 * SOHELATOR blueprint — phone / CarPlay friendly one-screen alert strings (no external AI).
 * Big emoji, score, play type, levels, historical context, EV, theta placeholder.
 */

/**
 * @param {object} setup
 * @param {string} setup.symbol
 * @param {number} setup.score
 * @param {number} [setup.edge]
 * @param {string} setup.playTypeLabel   SCALP | SWING | SCALP→SWING
 * @param {number} setup.entry
 * @param {number} setup.stop
 * @param {number} setup.target
 * @param {string} [setup.aiVerdict]
 * @param {string} [setup.historicalSummary]
 * @param {number} [setup.ev]
 * @param {number} [setup.projectedEv]
 * @param {string} [setup.thetaCountdown]
 * @returns {string}
 */
export function formatDrivingAlert(setup) {
  const sym = setup.symbol || "—";
  const score = setup.score != null ? Math.round(setup.score) : "—";
  const edge =
    setup.edge != null ? (Math.round(setup.edge * 1000) / 1000).toFixed(3) : "—";
  const play = setup.playTypeLabel || "—";
  const entry = fmt(setup.entry);
  const stop = fmt(setup.stop);
  const target = fmt(setup.target);
  const ai =
    setup.aiVerdict ||
    "AI verdict: pending (wire model later) — rules-based edge only right now.";
  const hist =
    setup.historicalSummary ||
    "Historical match: no similar backtest rows yet — run scan after market data loads.";
  const ev =
    setup.ev != null
      ? String(Math.round(setup.ev * 1000) / 1000)
      : setup.projectedEv != null
        ? String(Math.round(setup.projectedEv * 1000) / 1000)
        : "—";
  const theta =
    setup.thetaCountdown ||
    "Theta countdown: — (options greeks not wired in this path)";

  const opt = setup.suggestedOption;
  const optBlock =
    opt && opt.strike != null && opt.expiration
      ? [
          ``,
          `CONTRACT: ${String(opt.right || "").toUpperCase()} $${fmt(opt.strike)} exp ${opt.expiration}` +
            (opt.mid != null && Number.isFinite(Number(opt.mid))
              ? ` · est mid $${fmt(opt.mid)}`
              : "") +
            (opt.delta != null && Number.isFinite(Number(opt.delta))
              ? ` · delta ${Number(opt.delta).toFixed(2)}`
              : ""),
        ]
      : [];

  return [
    `🎯 SOHELATOR | ${sym}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `SCORE ${score}  |  EDGE ${edge}`,
    `PLAY: ${play}`,
    ``,
    `ENTRY  ${entry}`,
    `STOP   ${stop}`,
    `TARGET ${target}`,
    ...optBlock,
    ``,
    ai,
    ``,
    hist,
    ``,
    `EV (est.) ${ev}`,
    theta,
  ].join("\n");
}

function fmt(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return Number(n).toFixed(2);
}
