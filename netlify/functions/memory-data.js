const {
  getMemoryContext,
  getMemoryStore,
  buildAlertSnapshotPayload,
} = require("./lib/memory.cjs");
const { getMasterAnalysis } = require("./lib/masterAnalysis");
const { forecastSetup } = require("./lib/forecast");
const { getStore } = require("./lib/blobsStore.cjs");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

async function listEodKeys(learningStore) {
  const keys = [];
  try {
    for await (const page of learningStore.list({
      prefix: "eod_",
      paginate: true,
    })) {
      for (const b of page.blobs || []) {
        if (b.key && b.key !== "eod_latest") keys.push(b.key);
      }
    }
  } catch (e) {
    console.error("listEodKeys", e);
  }
  keys.sort();
  return keys;
}

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

  const q = event.queryStringParameters || {};
  const type = q.type || "memory";
  const ticker = q.ticker ? String(q.ticker).toUpperCase() : null;
  const dateParam = q.date || null;

  const memStore = getMemoryStore();
  const learningStore = getStore('learnings');

  try {
    if (type === "patterns") {
      const patterns = await memStore.get("patterns_all_time", {
        type: "json",
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(patterns || null),
      };
    }

    if (type === "forecast" && ticker) {
      const master = await getMasterAnalysis(ticker).catch(() => null);
      if (!master) {
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ ticker, forecast: null, error: "no master" }),
        };
      }
      const bias =
        master.timeframes?.tradingBias === "BEAR" ? "bear" : "bull";
      const synthetic = {
        id: "live_" + ticker,
        ticker,
        stage: bias,
        stageLabel: "LIVE",
        action: null,
        premiumAtAlert: 1,
        winRate: null,
        urgencyTier: null,
        option: {},
        volume: master.volume
          ? {
              ratio: master.volume.currentVolRatio,
              signal: master.volume.priceVolumeSignal,
            }
          : { ratio: 1 },
        ignition: null,
        indicators: {
          adx: master.timeframes?.fiveMin?.adx,
          rsi: master.timeframes?.fiveMin?.rsi,
          macd: master.timeframes?.fiveMin?.macd,
          vwapDist: 0,
        },
        underlyingAtAlert: master.price,
      };
      const snap = buildAlertSnapshotPayload(synthetic, master);
      snap.id = synthetic.id;
      const allTime = await memStore.get("patterns_all_time", {
        type: "json",
      });
      const forecast = await forecastSetup(snap, allTime);
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ticker, forecast }),
      };
    }

    if (type === "improvements") {
      const data = await learningStore.get("latest_improvements", {
        type: "json",
      });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify(data || null),
      };
    }

    if (type === "learning-log") {
      const eodKeys = await listEodKeys(learningStore);
      const recent = eodKeys.slice(-30).reverse();
      const items = [];
      for (const k of recent) {
        const row = await learningStore.get(k, { type: "json" });
        if (row) items.push(row);
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ days: items.length, reviews: items }),
      };
    }

    if (type === "snapshots") {
      let dateKey;
      if (dateParam === "today") {
        dateKey = new Date()
          .toLocaleDateString("en-US", { timeZone: "America/New_York" })
          .replace(/\//g, "_");
      } else if (dateParam) {
        dateKey = String(dateParam).replace(/\//g, "_");
      } else {
        dateKey = new Date()
          .toLocaleDateString("en-US", { timeZone: "America/New_York" })
          .replace(/\//g, "_");
      }
      const idList =
        (await memStore.get(`snapshots_${dateKey}`, { type: "json" })) || [];
      const ids = Array.isArray(idList) ? idList : [];
      const snapshots = await Promise.all(
        ids.map((id) => memStore.get(`snapshot_${id}`, { type: "json" }))
      );
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          dateKey,
          count: snapshots.filter(Boolean).length,
          snapshots: snapshots.filter(Boolean),
        }),
      };
    }

    const mem = await getMemoryContext(ticker || undefined);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(mem),
    };
  } catch (e) {
    console.error(e);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: e.message || "memory-data failed" }),
    };
  }
};
