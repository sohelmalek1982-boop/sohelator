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
| **`NETLIFY_SITE_ID`, `NETLIFY_TOKEN`** | **Required** for Netlify Blobs: 9:25/9:55/EOD reports, SCAN watchlist feed, alert dedup/history, job health. **Live quotes alone do not need these; everything above does.** Use this site’s **Site ID** and a personal access token with **Blobs** access. |
| `SERPER_API_KEY` | Optional: scanner ticker discovery |
| `SCAN_FORCE_SECRET` | Optional: `POST` scan-925 / scan-955 with `?force=<secret>` off-hours (see **Test scans off-hours**) |
| `SCANNER_TRIGGER_SECRET` | Optional: required `X-Scanner-Secret` header for `POST /api/scan-now` when set |

**Strategy thresholds (set from your backtests; defaults are textbook TA baselines)** — see `netlify/functions/lib/strategyParams.js` and **`GET /api/strategy-params`** (used by the UI so client and server stay aligned).

| Prefix | Examples |
|--------|----------|
| `SIGNAL_` | `SIGNAL_ADX_CHOP_MAX`, `SIGNAL_CALL_RSI_LO` / `HI`, `SIGNAL_PUT_RSI_LO` / `HI`, `SIGNAL_BB_CALL_MIN`, `SIGNAL_BB_PUT_MAX` |
| `SCANNER_` | `SCANNER_STAGE_ADX_REGIME_OFFSET`, `SCANNER_STAGE_VOL_SURGE_MULT`, `SCANNER_STAGE_VOL_SURGE_ADX_SUBTRACT`, `SCANNER_STAGE_ADX_GATE_FLOOR`, `SCANNER_BEAR_CONFIRMED_RSI_LO` / `HI`, `SCANNER_BEAR_OVERSOLD_RSI_MAX`, `SCANNER_BEAR_OVERSOLD_SCORE_BONUS`, `SCANNER_FLUSH_DAY_CHANGE_PCT`, `SCANNER_FLUSH_VWAP_DIST_PCT` |

Unset optional scanner values (flush, vol surge, oversold bonus) stay **off** until you set them from data.

Scheduled functions run in **UTC** (e.g. `scanner` every 5 min **13:00–21:59 UTC** Mon–Fri to cover US RTH). 9:25 / 9:55 jobs use `14:30` / `14:55` UTC (correct at **EST**; one hour later local time during **EDT**).

Optional model overrides: `ANTHROPIC_MODEL_SCANNER`, `ANTHROPIC_MODEL_CHAT`, `ANTHROPIC_MODEL_RESEARCH`, `ANTHROPIC_MODEL_LEARN`.

## Scanner behavior (chop vs alerts)

Per-symbol ADX stage gate is **regime min ADX minus** `SCANNER_STAGE_ADX_REGIME_OFFSET` (default 0), with optional **volume-surge** slack and **flush-day** chop bypass only when you set the corresponding env vars. **Alerts still require alert-eligible stages** (bull/bear/setup/fading with P&amp;L rule); pure chop never Telegrams. **`last_scan.scanDiagnostics`** in Blobs counts ADX chop skips and records `scannerAdxRegimeOffset`.

## Trusted tape windows

Volume/range tape boosts (scanner rank, ACT tier, SPY index-tape weighting in regime) apply only during **9:45–11:30** and **13:00–15:45** America/New_York. See `netlify/functions/lib/tapeTrustedWindow.js` (mirrored in the client).

## Test scans off-hours

`scan-925` / `scan-955` normally run only in short ET windows (see function code). To **fill Blobs and the SCAN tab tonight**:

1. In Netlify → **Environment variables**, add **`SCAN_FORCE_SECRET`** = a long random string (keep it private).
2. Redeploy (or wait for env to apply).
3. From a terminal (replace host and secret):

```bash
curl -sS -X POST "https://YOUR_SITE.netlify.app/api/scan-925?force=YOUR_SECRET"
curl -sS -X POST "https://YOUR_SITE.netlify.app/api/scan-955?force=YOUR_SECRET"
```

Or header: `-H "X-Scan-Force: YOUR_SECRET"` instead of `?force=`.

4. Open **`/api/scan-data`** or the app **SCAN** tab — you should see `scan925` / `scan955` objects. **Force runs may still Telegram** like a real scan.

**Without** `SCAN_FORCE_SECRET`, a POST still proves the function is wired: you get `{"skipped":true,...}` outside the morning window.

**Scanner / trade alerts** use `POST /api/scan-now` (optional header `X-Scanner-Secret` if `SCANNER_TRIGGER_SECRET` is set). That path **skips when Tradier says the market is closed**, so alert firing is best verified **RTH** or the next scheduled `*/5` run.

## 3:00 AM Eastern pipeline (`scan-3am`)

A **scheduled** function runs **Mon–Fri at 08:00 UTC** (`0 8 * * 1-5`), which is about **3:00 AM Eastern Standard Time** (about **4:00 AM** during daylight saving). It **POSTs** to your own `/api/scan-925` and `/api/scan-955` with `X-Scan-Force`, so you must set **`SCAN_FORCE_SECRET`** and have a normal deploy **`URL`** (Netlify sets this on production).

To move the run to ~3:00 AM local during **EDT**, change the cron in `netlify/functions/scan-3am.js` to `0 7 * * 1-5` (then you lose exact 3:00 AM in winter).

## Local

```bash
npm install
```

There is no separate front-end build; the app is `public/index.html`. Use the Netlify CLI to run functions locally if needed.
