/**
 * Broad market + sector ETF snapshot for morning briefs (Tradier quotes).
 */

import { getQuotesBatch } from "./tradier.js";
import { num } from "./utils.js";

const INDEX_DEFS = [
  { sym: "SPY", label: "S&P 500" },
  { sym: "QQQ", label: "Nasdaq 100" },
  { sym: "IWM", label: "Russell 2000" },
  { sym: "DIA", label: "Dow" },
];

/** Select Sector SPDR + common proxies */
const SECTOR_DEFS = [
  { sym: "XLK", name: "Technology" },
  { sym: "XLC", name: "Communication" },
  { sym: "XLY", name: "Cons. Disc." },
  { sym: "XLP", name: "Cons. Staples" },
  { sym: "XLE", name: "Energy" },
  { sym: "XLF", name: "Financials" },
  { sym: "XLV", name: "Health Care" },
  { sym: "XLI", name: "Industrials" },
  { sym: "XLB", name: "Materials" },
  { sym: "XLRE", name: "Real Estate" },
  { sym: "XLU", name: "Utilities" },
  { sym: "SMH", name: "Semiconductors" },
  { sym: "XBI", name: "Biotech" },
];

const MACRO_DEFS = [
  { sym: "VIX", name: "VIX" },
  { sym: "GLD", name: "Gold" },
  { sym: "TLT", name: "Long Treasuries" },
  { sym: "HYG", name: "HY Credit" },
];

/**
 * @param {Record<string, unknown>} q
 * @returns {number | null}
 */
function pctChange(q) {
  if (!q) return null;
  const prev = num(q.prevclose) || num(q.close) || 0;
  const last = num(q.last) || num(q.bid) || num(q.ask) || 0;
  if (!(prev > 0) || !(last > 0)) return null;
  return ((last - prev) / prev) * 100;
}

/**
 * Full-market tape: indices, sector leaders/laggards, macro proxies.
 * @returns {Promise<null | Record<string, unknown>>}
 */
export async function getMarketTapeSnapshot() {
  if (!process.env.TRADIER_TOKEN) return null;

  const allSyms = [
    ...INDEX_DEFS.map((x) => x.sym),
    ...SECTOR_DEFS.map((x) => x.sym),
    ...MACRO_DEFS.map((x) => x.sym),
  ];

  let quotes;
  try {
    quotes = await getQuotesBatch(allSyms);
  } catch {
    return null;
  }

  const indexRows = INDEX_DEFS.map((d) => {
    const q = quotes[d.sym];
    const pct = pctChange(q);
    return {
      symbol: d.sym,
      label: d.label,
      last: q ? num(q.last) || num(q.bid) : null,
      changePct: pct,
    };
  });

  const sectorRows = SECTOR_DEFS.map((d) => {
    const q = quotes[d.sym];
    const pct = pctChange(q);
    return {
      symbol: d.sym,
      name: d.name,
      changePct: pct,
    };
  }).filter((r) => r.changePct != null);

  const sorted = sectorRows.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
  const sectorsHot = sorted.slice(0, 5);
  const sectorsCold = sorted.slice(-5).reverse();

  const macro = MACRO_DEFS.map((d) => {
    const q = quotes[d.sym];
    const pct = pctChange(q);
    return { symbol: d.sym, name: d.name, last: q ? num(q.last) : null, changePct: pct };
  });

  const vixRow = macro.find((m) => m.symbol === "VIX");
  const adv =
    indexRows.filter((r) => (r.changePct || 0) > 0.1).length;
  const dec =
    indexRows.filter((r) => (r.changePct || 0) < -0.1).length;

  const breadthSummary =
    indexRows.length > 0
      ? `Indices green ${adv}/${indexRows.length} (vs red ${dec}/${indexRows.length}).`
      : "";

  return {
    asOf: new Date().toISOString(),
    indices: indexRows,
    sectorsAll: sorted,
    sectorsHot,
    sectorsCold,
    macro,
    vix: vixRow?.last,
    vixChangePct: vixRow?.changePct,
    breadthSummary,
  };
}
