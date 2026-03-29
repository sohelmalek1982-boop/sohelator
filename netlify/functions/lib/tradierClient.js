const fetch = require("node-fetch");

function tradierBase() {
  return (process.env.TRADIER_ENV || "production").toLowerCase() === "sandbox"
    ? "https://sandbox.tradier.com"
    : "https://api.tradier.com";
}

async function tradierGet(path, params = {}) {
  const token = process.env.TRADIER_TOKEN;
  if (!token) throw new Error("TRADIER_TOKEN missing");
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(params).map(([k, v]) => [k, String(v)])
    )
  ).toString();
  const res = await fetch(tradierBase() + path + (qs ? "?" + qs : ""), {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/json",
    },
  });
  return res.json();
}

function normList(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

module.exports = { tradierGet, normList, tradierBase };
