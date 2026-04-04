/**
 * SOHELATOR — Claude AI client replacing Grok
 */

export async function callClaude(model, prompt, maxTokens = 1200) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: model || process.env.ANTHROPIC_MODEL_CHAT || "claude-sonnet-4-6",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Claude API ${res.status}: ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.content?.[0]?.text || "";
}

export async function callClaudeExpensive(prompt, maxTokens = 2500) {
  const model = process.env.ANTHROPIC_MODEL_PREMARKET || "claude-sonnet-4-6";
  return callClaude(model, prompt, maxTokens);
}

export async function callClaudeCheap(prompt, maxTokens = 1200) {
  const model = process.env.ANTHROPIC_MODEL_CHAT || "claude-haiku-4-5-20251001";
  return callClaude(model, prompt, maxTokens);
}

export async function callClaudeWithFallback(prompt, maxTokens = 1200) {
  try {
    return await callClaudeExpensive(prompt, maxTokens);
  } catch (e) {
    console.warn("Claude expensive failed, trying cheap:", e?.message);
    try {
      return await callClaudeCheap(prompt, maxTokens);
    } catch (e2) {
      throw e;
    }
  }
}
