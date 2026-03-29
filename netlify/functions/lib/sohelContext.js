/**
 * SOHELATOR — full context for every Claude call + response parsing.
 */

function withSohelContext(systemPrompt, extraContext = "") {
  return `You are SOHELATOR — Sohel's personal
AI options trading partner. You have been
watching markets with him every day. You know
his style, his patterns, his wins and losses.

WHO YOU ARE:
You are not a generic AI assistant.
You are not a chatbot giving textbook answers.
You are Sohel's trading partner — direct,
specific, and honest. You've seen him make
mistakes and you call them out. You've seen
him nail setups and you reinforce what worked.

HOW YOU TALK:
- Direct. No fluff. No disclaimers.
- Specific. Exact tickers, exact strikes,
  exact prices, exact levels.
- Honest. If the setup is weak, say it's weak.
  If he should wait, tell him to wait.
- Conversational. Like a partner sitting
  next to him watching charts, not a report.
- Short when possible. He reads this on his
  phone while markets are moving.

SOHEL'S TRADING RULES (never violate these):
- Options ONLY. No stock positions.
- Swing 1-3 days preferred.
  Day trade only when forced.
- Hold over weekend IF profitable AND
  setup still intact AND no Monday earnings.
- NEVER trade earnings — binary risk, skip.
- Calls need: ADX>25, RSI 50-70,
  above VWAP, MACD positive.
- Puts need: ADX>25, RSI 30-50,
  below VWAP, MACD negative.
- IV rank low (<40%) = buy outright.
  IV rank high (>60%) = use debit spread.
- Stop loss: -40 to -50% on premium. Hard.
- Profit target: +80 to +150%.
- Trail stops: BE at +40%, trail +30% at
  +60%, half off at +80%, 75% off at +150%.
- Chop (ADX<20) = stand aside. Always.
- Never average down on a loser.
- Never hold a loser hoping it comes back.

WHAT YOU DO WITH THE DATA:
You receive institutional-grade market data:
- 5 timeframe analysis (5M/15M/1H/4H/Daily)
- GEX (gamma exposure) — pin vs explode
- Options flow — smart money positioning
- Market profile — POC, VAH, VAL
- Key levels — S/R from real price history
- Pivot zones — daily pivots R1/R2/S1/S2
- Advanced momentum — ATR, StochRSI, CCI
- Volume analysis — intraday 5m candles
- Ignition system — price+momentum+volume
  acceleration score
- Level interaction — breakout/breakdown/
  rejection/bounce detection
- Sector correlation — tailwind/headwind
- Earnings calendar — auto-skip
- Memory — Sohel's personal win rates
  by ticker, pattern, day of week
- Behavioral patterns — what he does wrong

YOU MUST:
1. Look at ALL data together, not in isolation
2. Identify the ONE most important thing
   happening right now
3. Resolve contradictions explicitly
   ("GEX says explosive but RSI says careful —
   here's how I read that tension...")
4. Give a specific recommendation every time
   Never say "it depends" when data is clear
5. Reference his personal stats when relevant
   ("You win 71% on NVDA bull setups —
   this is exactly that setup")
6. Call out behavioral risks proactively
   ("You tend to exit early — don't do it
   here, setup is still intact")
7. Be honest about uncertainty
   ("I'm 65% confident here, not 90%,
   because volume isn't confirming yet")
8. Always give: entry, stop, target
   Not just "looks bullish"

YOU MUST NEVER:
- Give generic textbook indicator definitions
- Say "RSI is 58 which suggests bullish"
  without context of what that means TODAY
- Hedge everything with disclaimers
- Recommend holding a loser
- Ignore what the levels are saying
- Pretend you're confident when you're not
- Recommend a trade during earnings week
- Recommend entering during chop (ADX<20)
- Tell him to average down on a losing option

WHEN THE SETUP IS WEAK:
Be direct. "This is a 2/10 setup. 
ADX is 14, no trend exists, volume is flat.
Don't trade this. Look at [better ticker]."

WHEN THE SETUP IS STRONG:
Be specific. "This is a 9/10 setup.
All 3 ignition engines firing, broke above
pivot R1 on 2.8x volume, GEX negative 
(explosive move expected), options flow
showing unusual call activity at this strike.
You win 71% of NVDA bull breakout setups.
This is your trade. Buy the $885C. Now."

WHEN YOU'RE UNCERTAIN:
Be honest. "I'm 60% on this. Volume isn't
confirming yet. Wait one more candle.
If it closes above $880 with >1.5x volume —
enter. If not — skip it."

${systemPrompt}

${extraContext ? "ADDITIONAL CONTEXT:\n" + extraContext : ""}`;
}

function normalizeIgnitionForContext(ign) {
  if (!ign) return null;
  if (ign.ignitionScore != null) return ign;
  if (ign.score != null) {
    return {
      ignitionScore: ign.score,
      status: ign.status,
      direction: ign.direction,
      engines: ign.engines,
    };
  }
  return null;
}

function buildTradingContext(master, ticker, price, memory) {
  if (!master && !memory) return "";

  const lines = [];
  const T = (ticker || "TICKER").toUpperCase();
  const px = typeof price === "number" && isFinite(price) ? price : null;

  lines.push("═══ CURRENT MARKET SITUATION ═══");
  lines.push(`Ticker: ${T}`);
  lines.push(`Price: $${px != null ? px.toFixed(2) : "—"}`);
  lines.push(
    `Time: ${new Date().toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
    })} ET`
  );
  lines.push("");

  if (master?.regime) {
    const rg = master.regime;
    lines.push("MARKET REGIME:");
    lines.push(rg.description || rg.primary || "");
    lines.push(`Risk regime: ${rg.riskRegime || "—"}`);
    lines.push(`VIX context: ${rg.vixRegime || "—"}`);
    lines.push("");
  }

  const ign = normalizeIgnitionForContext(master?.ignition);
  if (ign) {
    lines.push("IGNITION SYSTEM:");
    lines.push(`Status: ${ign.status} (score: ${ign.ignitionScore}/100)`);
    lines.push(`Direction: ${ign.direction}`);
    lines.push(
      `Price engine: ${ign.engines?.price?.status} (${ign.engines?.price?.ratio}x range)`
    );
    lines.push(
      `Momentum engine: ${ign.engines?.momentum?.status} — MACD expanding ${ign.engines?.momentum?.expandingBars ?? 0} bars`
    );
    lines.push(
      `Volume engine: ${ign.engines?.volume?.status} (${ign.engines?.volume?.ratio}x recent)`
    );
    lines.push("");
  }

  if (master?.levelInteraction) {
    const li = master.levelInteraction;
    lines.push("LEVEL INTERACTION — MOST IMPORTANT:");
    lines.push(
      `${li.interactionType} at ${li.level?.label} $${li.level?.price?.toFixed(2)}`
    );
    lines.push(`Confidence: ${li.confidence}%`);
    lines.push(`Volume: ${li.volRatio}x`);
    if (li.setup) {
      lines.push(li.setup.what);
      lines.push(`→ ${li.setup.action}`);
      lines.push(`Entry: ${li.setup.entryNote}`);
      lines.push(`Stop: ${li.setup.stopNote}`);
      lines.push(`Target: ${li.setup.targetNote}`);
      if (li.setup.riskReward) lines.push(`R/R: ${li.setup.riskReward}:1`);
      if (li.setup.warningNote) lines.push(li.setup.warningNote);
    }
    lines.push("");
  }

  const tf = master?.timeframes;
  if (tf) {
    lines.push("TIMEFRAME ALIGNMENT:");
    lines.push(
      `Daily: ${tf.daily?.trend} (ADX ${Number(tf.daily?.adx).toFixed(1)}, RSI ${Number(tf.daily?.rsi).toFixed(1)})`
    );
    lines.push(
      `4H: ${tf.fourHour?.trend} | 1H: ${tf.oneHour?.trend} | 15M: ${tf.fifteenMin?.trend} | 5M: ${tf.fiveMin?.trend}`
    );
    lines.push(
      `Overall alignment: ${tf.alignmentScore}/100 (${tf.confluenceLevel})`
    );
    lines.push(`Bias: ${tf.tradingBias}`);
    lines.push("");
  }

  if (master?.gex) {
    const gex = master.gex;
    lines.push("GAMMA EXPOSURE:");
    lines.push(gex.interpretation || gex.gexRegime || "");
    if (gex.gexFlipLevel) lines.push(`Flip level: $${gex.gexFlipLevel}`);
    if (gex.tradingImplication?.flipWarning) {
      lines.push(gex.tradingImplication.flipWarning);
    }
    lines.push("");
  }

  if (master?.optionsFlow) {
    const flow = master.optionsFlow;
    lines.push("OPTIONS FLOW:");
    lines.push(String(flow.flowSentiment || flow.smartMoneyBias || ""));
    lines.push(`Smart money: ${flow.smartMoneyBias}`);
    if (flow.topUnusualCall) {
      const uc = flow.topUnusualCall;
      lines.push(
        `Unusual calls: ${uc.volume} contracts at $${uc.strike} exp ${uc.expiration || uc.expiry} (${uc.isNewMoney ? "NEW MONEY" : "existing"})`
      );
    }
    if (flow.topUnusualPut) {
      const up = flow.topUnusualPut;
      lines.push(`Unusual puts: ${up.volume} contracts at $${up.strike}`);
    }
    if (flow.volumePCR != null) {
      lines.push(`PCR: ${Number(flow.volumePCR).toFixed(2)}`);
    }
    if (flow.skewInterpretation) lines.push(`Skew: ${flow.skewInterpretation}`);
    if (flow.maxPainStrike) lines.push(`Max pain: $${flow.maxPainStrike}`);
    lines.push("");
  }

  if (master?.marketProfile) {
    const mp = master.marketProfile;
    lines.push("MARKET PROFILE:");
    lines.push(
      `POC: $${mp.poc?.toFixed(2)} | VAH: $${mp.vah?.toFixed(2)} | VAL: $${mp.val?.toFixed(2)}`
    );
    lines.push(`Price position: ${mp.pricePosition}`);
    lines.push(mp.interpretation || "");
    lines.push("");
  }

  const lv = master?.levels;
  if (lv) {
    lines.push("KEY LEVELS:");
    if (lv.nearestResistance) {
      lines.push(
        `Nearest resistance: $${lv.nearestResistance.price?.toFixed(2)} (${lv.nearestResistance.label}) — ${lv.nearestResistance.distancePct}% away`
      );
    }
    if (lv.nearestSupport) {
      lines.push(
        `Nearest support: $${lv.nearestSupport.price?.toFixed(2)} (${lv.nearestSupport.label}) — ${Math.abs(lv.nearestSupport.distancePct)}% below`
      );
    }
    if (lv.riskRewardRatio) {
      lines.push(`R/R to nearest levels: ${lv.riskRewardRatio}:1`);
    }
    if (lv.nearResistanceWarning) lines.push(lv.nearResistanceWarning);
    lines.push("");
  }

  if (master?.volume) {
    const vol = master.volume;
    lines.push("INTRADAY VOLUME (5M):");
    const sig = vol.priceVolumeSignal || vol.signal || "—";
    lines.push(`Signal: ${sig}`);
    const det =
      typeof vol.interpretation === "string"
        ? vol.interpretation
        : vol.interpretation?.detail || vol.interpretation?.text || "";
    if (det) lines.push(det);
    if (vol.alerts?.length > 0) {
      vol.alerts.forEach((a) =>
        lines.push(`! ${a.message || a}`)
      );
    }
    lines.push("");
  }

  if (master?.sector) {
    const sec = master.sector;
    lines.push("SECTOR:");
    lines.push(sec.sectorAdvice || sec.summary || "");
    lines.push(`Market breadth: ${sec.marketBreadth}`);
    lines.push(`Macro: ${sec.macroSignal}`);
    lines.push("");
  }

  if (master?.earnings?.hasEarnings) {
    lines.push("⚠️ EARNINGS WARNING:");
    lines.push(master.earnings.warning || "Earnings nearby — skip.");
    lines.push("");
  }

  if (memory) {
    lines.push("SOHEL'S PERSONAL STATS:");

    if (memory.insights?.length > 0) {
      memory.insights.forEach((i) => lines.push(`• ${i}`));
    }

    const tickerStats = memory.allTickerStats?.find(
      (t) => (t.ticker || "").toUpperCase() === T
    );
    if (tickerStats?.totalTrades >= 3) {
      lines.push(
        `${T} personal record: ${tickerStats.winRate}% win rate (${tickerStats.totalTrades} trades)`
      );
      if (tickerStats.avgWinPct) {
        lines.push(`Avg win: +${tickerStats.avgWinPct.toFixed(0)}%`);
      }
    }

    const beh = memory.behavioralStats;
    if (beh?.exitTooEarlyCount > 2) {
      lines.push(
        `⚠️ BEHAVIORAL: You have exited winners too early ${beh.exitTooEarlyCount} times. If setup is intact — HOLD.`
      );
    }
    if (beh?.heldLoserCount > 2) {
      lines.push(
        `⚠️ BEHAVIORAL: You have held losers too long ${beh.heldLoserCount} times. Cut at -40% — no exceptions.`
      );
    }

    lines.push("");
  }

  if (master?.pivotZones) {
    const pz = master.pivotZones;
    lines.push("PIVOT ZONES (from yesterday):");
    lines.push(`R2: $${pz.r2} | R1: $${pz.r1} | PP: $${pz.pp}`);
    lines.push(`S1: $${pz.s1} | S2: $${pz.s2}`);
    lines.push("");
  }

  lines.push("═══════════════════════════════");

  return lines.join("\n");
}

function extractAction(text) {
  const t = String(text || "");
  if (/buy calls/i.test(t)) return "BUY_CALLS";
  if (/buy puts/i.test(t)) return "BUY_PUTS";
  if (/exit|close|sell/i.test(t)) return "EXIT";
  if (/take half/i.test(t)) return "TAKE_HALF";
  if (/hold/i.test(t)) return "HOLD";
  if (/wait|stand aside/i.test(t)) return "WAIT";
  return "MONITOR";
}

function extractOption(text) {
  const m = String(text || "").match(
    /\$(\d+\.?\d*)\s*(C|P|call|put)/i
  );
  if (!m) return null;
  const typ = /^c/i.test(m[2]) ? "call" : "put";
  return { strike: parseFloat(m[1]), type: typ };
}

function extractStop(text) {
  const s = String(text || "");
  const pct = s.match(/stop[:\s]+-?(\d+)\s*%/i);
  if (pct) return `-${pct[1]}%`;
  const px = s.match(/stop\s+(?:at\s+)?\$(\d+(?:\.\d+)?)/i);
  if (px) return `$${px[1]}`;
  return null;
}

function extractTarget(text) {
  const s = String(text || "");
  const pct = s.match(/target[:\s]+\+?(\d+)\s*%/i);
  if (pct) return `+${pct[1]}%`;
  const px = s.match(/target[:\s]+\$(\d+(?:\.\d+)?)/i);
  if (px) return `$${px[1]}`;
  return null;
}

function extractConfidence(text) {
  const s = String(text || "");
  const m = s.match(
    /(\d+)\s*%\s*(confident|confidence|probability|win rate|chance)/i
  );
  if (m) return parseInt(m[1], 10);
  const m2 = s.match(/(\d+)\s*%\s*(confident|sure)/i);
  return m2 ? parseInt(m2[1], 10) : null;
}

function parseClaudeResponse(text) {
  const fullText = String(text || "");
  return {
    fullText,
    action: extractAction(fullText),
    option: extractOption(fullText),
    stop: extractStop(fullText),
    target: extractTarget(fullText),
    confidence: extractConfidence(fullText),
    isNoTrade: /stand aside|do not|wait|skip|avoid|chop/i.test(fullText),
    urgency:
      /now|immediately|right now|act fast/i.test(fullText)
        ? "HIGH"
        : /watch|prepare|get ready/i.test(fullText)
          ? "MEDIUM"
          : "LOW",
  };
}

module.exports = {
  withSohelContext,
  buildTradingContext,
  parseClaudeResponse,
  normalizeIgnitionForContext,
  extractAction,
  extractOption,
  extractStop,
  extractTarget,
  extractConfidence,
};
