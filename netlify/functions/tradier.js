const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Requested-With",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

exports.handler = async (event) => {
  const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: jsonHeaders, body: "" };
  }

  const token = process.env.TRADIER_TOKEN;
  const accountId = process.env.TRADIER_ACCOUNT_ID || "";
  const tradierEnv = (process.env.TRADIER_ENV || "production").toLowerCase();

  if (!token) {
    return {
      statusCode: 500,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: "TRADIER_TOKEN is not set. Add it in Netlify environment variables.",
      }),
    };
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return {
      statusCode: 400,
      headers: jsonHeaders,
      body: JSON.stringify({ error: "Invalid JSON body" }),
    };
  }

  const {
    path: apiPath = "",
    method = "GET",
    params = {},
    body: formBody = {},
  } = payload;

  const baseUrl =
    tradierEnv === "sandbox"
      ? "https://sandbox.tradier.com"
      : "https://api.tradier.com";

  let pathWithAccount = String(apiPath).replace(/{ACCOUNT_ID}/g, accountId);

  if (!pathWithAccount.startsWith("/")) {
    pathWithAccount = "/" + pathWithAccount;
  }

  let url = baseUrl + pathWithAccount;
  const m = String(method).toUpperCase();

  if (m === "GET" && params && typeof params === "object") {
    const entries = Object.entries(params).filter(
      ([, v]) => v !== undefined && v !== null && v !== ""
    );
    if (entries.length) {
      const qs = new URLSearchParams(
        Object.fromEntries(entries.map(([k, v]) => [k, String(v)]))
      ).toString();
      url += (url.includes("?") ? "&" : "?") + qs;
    }
  }

  const init = {
    method: m,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
  };

  if (m === "POST") {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    const fd =
      formBody && typeof formBody === "object"
        ? new URLSearchParams(
            Object.fromEntries(
              Object.entries(formBody).map(([k, v]) => [k, String(v)])
            )
          ).toString()
        : "";
    init.body = fd;
  }

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    return {
      statusCode: res.ok ? 200 : res.status,
      headers: jsonHeaders,
      body: JSON.stringify(data),
    };
  } catch (err) {
    return {
      statusCode: 502,
      headers: jsonHeaders,
      body: JSON.stringify({
        error: err.message || "Upstream request failed",
      }),
    };
  }
};
