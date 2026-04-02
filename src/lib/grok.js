/**
 * SOHELATOR blueprint — xAI Grok chat completions helper.
 *
 * Netlify environment variables (set in Site configuration → Environment variables):
 * - GROK_API_KEY — required for any Grok call
 * - GROK_MODEL_EXPENSIVE — default "grok-4.20-0309-reasoning" (scan co-pilot, pre-market brief)
 * - GROK_MODEL_CHEAP — default "grok-4-1-fast-reasoning" (nightly summary)
 */

export const GROK_BASE = "https://api.x.ai/v1";

/**
 * @param {string} model e.g. "grok-4.20-0309-reasoning" | "grok-4-1-fast-reasoning"
 * @param {string} prompt
 * @param {number} [maxTokens=2000]
 * @returns {Promise<string>} Assistant message content
 */
export async function callGrok(model, prompt, maxTokens = 2000) {
  const key = process.env.GROK_API_KEY;
  if (!key || !String(key).trim()) {
    throw new Error(
      "GROK_API_KEY is not set — add it in Netlify environment variables."
    );
  }

  const url = `${GROK_BASE}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: String(prompt) }],
      max_tokens: maxTokens,
    }),
  });

  const raw = await res.text();
  if (!res.ok) {
    throw new Error(
      `Grok API HTTP ${res.status}: ${raw.slice(0, 600)}`
    );
  }

  let j;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new Error(`Grok API returned non-JSON: ${raw.slice(0, 200)}`);
  }

  const content = j?.choices?.[0]?.message?.content;
  if (content == null || String(content).trim() === "") {
    throw new Error("Grok returned empty assistant message.");
  }

  return typeof content === "string" ? content : String(content);
}
