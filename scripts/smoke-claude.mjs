/**
 * Local smoke test: ANTHROPIC_API_KEY + Messages API (same endpoint/headers as src/lib/claude.js).
 * Usage: ANTHROPIC_API_KEY=sk-ant-... npm run test:claude
 */
const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.error(
    "Set ANTHROPIC_API_KEY in the environment to run this check (same key as Netlify)."
  );
  process.exit(2);
}

const model =
  process.env.ANTHROPIC_MODEL_CHAT || "claude-haiku-4-5-20251001";

try {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 64,
      messages: [{ role: "user", content: "Reply with exactly: pong" }],
    }),
  });
  const raw = await res.text();
  if (!res.ok) {
    console.error("HTTP", res.status, raw.slice(0, 400));
    process.exit(1);
  }
  const data = JSON.parse(raw);
  const text = data.content?.[0]?.text || "";
  if (!/pong/i.test(String(text))) {
    console.error("Unexpected body:", String(text).slice(0, 500));
    process.exit(1);
  }
  console.log("Claude OK:", String(text).trim().slice(0, 120));
  process.exit(0);
} catch (e) {
  console.error("Claude API error:", e?.message || e);
  process.exit(1);
}
