const fetch = require("node-fetch");
const { tradierGet } = require("./tradierClient");

async function serperSearch(query) {
  const key = process.env.SERPER_API_KEY;
  if (!key) return { organic: [] };
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "X-API-KEY": key,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: query, num: 8 }),
  });
  return res.json();
}

async function checkEarnings(ticker) {
  const sym = String(ticker || "").toUpperCase();
  if (!sym) {
    return { hasEarnings: false, daysToEarnings: null, warning: null };
  }

  try {
    const fundamentals = await tradierGet(
      "/beta/markets/fundamentals/calendars",
      { symbols: sym }
    );
    const calendar = fundamentals?.calendars?.[sym]?.earnings;
    if (calendar?.date) {
      const earningsDate = new Date(calendar.date);
      const today = new Date();
      const daysToEarnings = Math.round(
        (earningsDate - today) / 86400000
      );
      return {
        hasEarnings: true,
        earningsDate: calendar.date,
        daysToEarnings,
        isThisWeek: daysToEarnings >= 0 && daysToEarnings <= 5,
        isSoon: daysToEarnings >= 0 && daysToEarnings <= 14,
        warning:
          daysToEarnings <= 5
            ? `EARNINGS IN ${daysToEarnings} DAYS — SKIP. Binary risk.`
            : daysToEarnings <= 14
              ? `Earnings in ${daysToEarnings} days. Watch IV carefully.`
              : null,
        source: "tradier",
      };
    }
  } catch {
    /* fall through */
  }

  try {
    const result = await serperSearch(
      `${sym} earnings date next quarter 2026`
    );
    const snippets =
      result.organic?.map((r) => r.snippet).join(" ") || "";
    const datePattern =
      /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s*\d{4}/i;
    const match = snippets.match(datePattern);
    if (match) {
      const earningsDate = new Date(match[0]);
      const today = new Date();
      const daysToEarnings = Math.round(
        (earningsDate - today) / 86400000
      );
      if (daysToEarnings >= 0 && daysToEarnings < 90) {
        return {
          hasEarnings: true,
          earningsDate: match[0],
          daysToEarnings,
          isThisWeek: daysToEarnings <= 5,
          isSoon: daysToEarnings <= 14,
          warning:
            daysToEarnings <= 5
              ? `EARNINGS IN ${daysToEarnings} DAYS — SKIP`
              : null,
          source: "search",
        };
      }
    }
  } catch {
    /* ignore */
  }

  return {
    hasEarnings: false,
    daysToEarnings: null,
    warning: null,
  };
}

module.exports = { checkEarnings, serperSearch };
