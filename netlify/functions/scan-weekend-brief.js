const fetch = require("node-fetch");
const { getStore } = require("@netlify/blobs");
const { schedule } = require("@netlify/functions");

async function sendTelegram(htmlOrText) {
  const bot = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!bot || !chat) return;
  await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chat,
      text: htmlOrText,
      parse_mode: "HTML",
    }),
  });
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function runSundayBrief() {
  const store = getStore('morning-scans');
  const intel = await store.get("weekend_intel_latest", { type: "json" });
  if (!intel?.claudeAnalysis) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: false, reason: "No weekend intel yet" }),
    };
  }

  const weekOf = intel.weekOf || "next week";
  const msg = `📅 <b>SOHELATOR WEEKLY PREVIEW</b>
Week of ${weekOf}

<b>NEXT WEEK GAME PLAN:</b>
${esc(intel.claudeAnalysis)}

<b>SETUPS TO WATCH (daily scan):</b>
${(intel.snapshots || [])
  .slice(0, 3)
  .map((s) => `• ${s.symbol} $${s.close.toFixed(2)} RSI ${s.rsi}`)
  .join("\n")}

<b>KEY EVENTS (headlines):</b>
${(intel.headlines || [])
  .slice(0, 4)
  .map((h) => "• " + esc(h.slice(0, 120)))
  .join("\n")}

See you at 9:25am Monday 🚀`;

  await sendTelegram(msg);

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
}

exports.handler = schedule("0 21 * * 0", runSundayBrief);
