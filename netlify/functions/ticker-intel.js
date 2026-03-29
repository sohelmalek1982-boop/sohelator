const { getMasterAnalysis } = require("./lib/masterAnalysis");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

exports.handler = async (event) => {
  const headers = { ...cors, "Content-Type": "application/json" };
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }
  if (event.httpMethod !== "GET") {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: "GET only" }),
    };
  }

  const sym = String(
    event.queryStringParameters?.symbol || ""
  ).toUpperCase();
  if (!sym || sym.length > 8) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "symbol query required" }),
    };
  }

  try {
    const m = await getMasterAnalysis(sym);
    if (!m) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: "No data" }),
      };
    }

    const payload = {
      symbol: m.symbol,
      price: m.price,
      confidence: m.confidence,
      tradingBias: m.tradingBias,
      summary: m.summary,
      gex: m.gex
        ? {
            gexRegime: m.gex.gexRegime,
            interpretation: m.gex.interpretation,
            gexFlipLevel: m.gex.gexFlipLevel,
            flipWarning: m.gex.tradingImplication?.flipWarning,
            gexResistance: m.gex.gexResistance,
            gexSupport: m.gex.gexSupport,
          }
        : null,
      optionsFlow: m.optionsFlow
        ? {
            smartMoneyBias: m.optionsFlow.smartMoneyBias,
            volumePCR: m.optionsFlow.volumePCR,
            oiPCR: m.optionsFlow.oiPCR,
            unusualActivity: (m.optionsFlow.unusualActivity || []).slice(0, 4),
            flowSummary: m.optionsFlow.flowSummary,
          }
        : null,
      marketProfile: m.marketProfile
        ? {
            poc: m.marketProfile.poc,
            vah: m.marketProfile.vah,
            val: m.marketProfile.val,
            pricePosition: m.marketProfile.pricePosition,
            summary: m.marketProfile.summary,
          }
        : null,
      levels: m.levels
        ? {
            nearestResistance: m.levels.nearestResistance,
            nearestSupport: m.levels.nearestSupport,
            riskRewardRatio: m.levels.riskRewardRatio,
            summary: m.levels.summary,
          }
        : null,
      momentum: m.momentum
        ? {
            atr: m.momentum.atr,
            atrPct: m.momentum.atrPct,
            expectedMoveUp: m.momentum.expectedMoveUp,
            expectedMoveDown: m.momentum.expectedMoveDown,
            stochRSI: m.momentum.stochRSI,
            williamsR: m.momentum.williamsR,
            cci: m.momentum.cci,
            obvTrend: m.momentum.obvTrend,
            momentumBias: m.momentum.momentumBias,
          }
        : null,
      sector: m.sector
        ? {
            tickerSector: m.sector.tickerSector,
            sectorPerformance: m.sector.sectorPerformance,
            sectorMomentum: m.sector.sectorMomentum,
            tailwind: m.sector.tailwind,
            headwind: m.sector.headwind,
            topSectors: (m.sector.topSectors || []).slice(0, 3),
            sectorAdvice: m.sector.sectorAdvice,
          }
        : null,
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(payload),
    };
  } catch (e) {
    console.error("ticker-intel", e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message || "intel failed" }),
    };
  }
};
