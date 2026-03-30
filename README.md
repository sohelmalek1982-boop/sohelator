# SOHELATOR

Trading UI (`public/`) and Netlify serverless functions: scanners, Tradier-backed quotes, Claude analysis, Telegram/email/push alerts, and tape-aware scoring.

## Deploy (Netlify)

- **Publish directory:** `public`
- **Functions:** `netlify/functions` (bundled with esbuild per `netlify.toml`)
- After UI changes, `index.html` is sent with `Cache-Control: max-age=0` so clients pick up updates quickly.

## Environment variables (Netlify site settings)

| Variable | Role |
|----------|------|
| `TRADIER_TOKEN`, `TRADIER_ACCOUNT_ID` | Market data / trading API |
| `TRADIER_ENV` | `sandbox` or production |
| `ANTHROPIC_API_KEY` | AI (scanner, chat, research brief) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Alert Telegram |
| `RESEND_API_KEY`, `ALERT_EMAIL`, `RESEND_FROM_EMAIL` | Alert email |
| `NETLIFY_SITE_ID`, `NETLIFY_TOKEN` | Blobs / job hooks |
| `SERPER_API_KEY` | Optional: scanner ticker discovery |

Optional model overrides: `ANTHROPIC_MODEL_SCANNER`, `ANTHROPIC_MODEL_CHAT`, `ANTHROPIC_MODEL_RESEARCH`, `ANTHROPIC_MODEL_LEARN`.

## Trusted tape windows

Volume/range tape boosts (scanner rank, ACT tier, SPY index-tape weighting in regime) apply only during **9:45–11:30** and **13:00–15:45** America/New_York. See `netlify/functions/lib/tapeTrustedWindow.js` (mirrored in the client).

## Local

```bash
npm install
```

There is no separate front-end build; the app is `public/index.html`. Use the Netlify CLI to run functions locally if needed.
