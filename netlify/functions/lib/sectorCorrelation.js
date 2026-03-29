const { tradierGet, normList } = require("./tradierClient");

const SECTOR_ETFS = {
  Technology: "XLK",
  Semiconductors: "SMH",
  Energy: "XLE",
  Financials: "XLF",
  Healthcare: "XLV",
  "Consumer Disc": "XLY",
  "ARK Innovation": "ARKK",
  "Crypto-related": "BITO",
  Volatility: "VIX",
  Bonds: "TLT",
  Gold: "GLD",
  Dollar: "UUP",
};

const TICKER_SECTORS = {
  NVDA: "Semiconductors",
  AMD: "Semiconductors",
  SMCI: "Semiconductors",
  ARM: "Semiconductors",
  MU: "Semiconductors",
  AVGO: "Semiconductors",
  TSM: "Semiconductors",
  MSFT: "Technology",
  GOOGL: "Technology",
  META: "Technology",
  AAPL: "Technology",
  AMZN: "Technology",
  NFLX: "Technology",
  SNOW: "Technology",
  DDOG: "Technology",
  CRWD: "Technology",
  NET: "Technology",
  PANW: "Technology",
  PLTR: "Technology",
  TSLA: "Consumer Disc",
  RIVN: "Consumer Disc",
  COIN: "Crypto-related",
  MSTR: "Crypto-related",
  HOOD: "Financials",
  SQ: "Financials",
  SOFI: "Financials",
  PYPL: "Financials",
  IONQ: "Technology",
  RKLB: "Technology",
  UBER: "Consumer Disc",
};

async function analyzeSectorContext(ticker) {
  const sym = String(ticker || "SPY").toUpperCase();
  const tickerSector = TICKER_SECTORS[sym] || "Technology";
  const sectorETF = SECTOR_ETFS[tickerSector] || "XLK";

  const allETFs = Object.values(SECTOR_ETFS).filter((s) => s !== "VIX");

  const quotesData = await tradierGet("/v1/markets/quotes", {
    symbols: allETFs.join(","),
  });
  const quotes = quotesData.quotes?.quote;
  const quotesArr = normList(quotes);

  const sectorPerf = {};
  for (const q of quotesArr) {
    sectorPerf[q.symbol] = {
      change: +q.change_percentage || 0,
      price: +q.last || +q.close || 0,
      volume: +q.volume || 0,
    };
  }

  const myETFPerf = sectorPerf[sectorETF];

  const sectorRanking = Object.entries(SECTOR_ETFS)
    .filter(([, etf]) => sectorPerf[etf])
    .map(([name, etf]) => ({
      name,
      etf,
      change: sectorPerf[etf]?.change || 0,
    }))
    .sort((a, b) => b.change - a.change);

  const topSectors = sectorRanking.slice(0, 3);
  const bottomSectors = sectorRanking.slice(-3);
  const sectorRank =
    sectorRanking.findIndex((s) => s.etf === sectorETF) + 1;
  const totalSectors = sectorRanking.length;
  const sectorMomentum =
    sectorRank <= 3
      ? "LEADING"
      : sectorRank >= totalSectors - 2
        ? "LAGGING"
        : "NEUTRAL";

  const advancing = sectorRanking.filter((s) => s.change > 0).length;
  const declining = sectorRanking.filter((s) => s.change < 0).length;
  const breadth = totalSectors ? advancing / totalSectors : 0.5;

  const marketBreadth =
    breadth > 0.7
      ? "BROAD RALLY — most sectors up"
      : breadth > 0.5
        ? "SELECTIVE — mixed action"
        : breadth < 0.3
          ? "BROAD SELLOFF — most sectors down"
          : "SPLIT MARKET";

  const tlt = sectorPerf.TLT;
  const gld = sectorPerf.GLD;
  const uup = sectorPerf.UUP;

  let macroSignal = "NEUTRAL";
  if (tlt && tlt.change < -0.5 && uup && uup.change > 0) {
    macroSignal = "RISK-OFF — bonds selling, dollar rising";
  } else if (tlt && tlt.change > 0.5 && gld && gld.change > 0) {
    macroSignal = "DEFENSIVE — money moving to safety";
  } else if (advancing > declining * 1.5) {
    macroSignal = "RISK-ON — broad buying";
  }

  return {
    tickerSector,
    sectorETF,
    sectorPerformance: myETFPerf?.change || 0,
    sectorMomentum,
    sectorRank,
    topSectors,
    bottomSectors,
    sectorRanking,
    marketBreadth,
    breadthScore: +(breadth * 100).toFixed(0),
    macroSignal,
    tailwind: sectorMomentum === "LEADING",
    headwind: sectorMomentum === "LAGGING",
    sectorAdvice:
      sectorMomentum === "LEADING"
        ? `${tickerSector} is leading today (${(myETFPerf?.change ?? 0).toFixed(2)}%). Sector tailwind — supports the trade.`
        : sectorMomentum === "LAGGING"
          ? `${tickerSector} is lagging today (${(myETFPerf?.change ?? 0).toFixed(2)}%). Sector headwind — reduces conviction.`
          : `${tickerSector} neutral. No strong sector tailwind or headwind.`,
    summary: `Sector: ${tickerSector} (${sectorMomentum}). Market: ${marketBreadth}. Macro: ${macroSignal}`,
  };
}

module.exports = {
  analyzeSectorContext,
  TICKER_SECTORS,
  SECTOR_ETFS,
};
