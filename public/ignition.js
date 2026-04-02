/**
 * Three-engine ignition (browser) — keep in sync with netlify/functions/lib/ignition.js
 */
function calculateIgnition(candles, indicators) {
  if (!candles || candles.length < 5) return null;

  const closes = candles.map((c) => c.close);
  const opens = candles.map((c) => c.open || c.close);
  const vols = candles.map((c) => c.volume || c.vol || 0);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const len = candles.length;
  const cur = len - 1;
  const prev = len - 2;
  const prev2 = len - 3;

  const candleRanges = candles.slice(-6, -1).map((c) => Math.abs(c.high - c.low));
  const avgRange =
    candleRanges.length > 0 ? candleRanges.reduce((a, b) => a + b, 0) / candleRanges.length : 1;
  const currentRange = Math.abs(highs[cur] - lows[cur]);
  const priceAccelRatio = avgRange > 0 ? currentRange / avgRange : 1;

  const candleDirectional = Math.abs(closes[cur] - opens[cur]) > currentRange * 0.4;

  const priceUp = closes[cur] > opens[cur];
  const prevPriceUp = closes[prev] > opens[prev];
  const consistent = priceUp === prevPriceUp;

  let priceScore = 0;
  if (priceAccelRatio >= 2.5) priceScore = 95;
  else if (priceAccelRatio >= 2.0) priceScore = 85;
  else if (priceAccelRatio >= 1.5) priceScore = 70;
  else if (priceAccelRatio >= 1.2) priceScore = 50;
  else if (priceAccelRatio >= 0.9) priceScore = 30;
  else priceScore = 10;

  if (candleDirectional) priceScore += 5;
  if (consistent) priceScore += 5;
  priceScore = Math.min(100, priceScore);

  const macd = indicators?.macd || 0;
  const macdPrev = indicators?.macdPrev || 0;
  const macdPrev2 = indicators?.macdPrev2 || 0;
  const rsi = indicators?.rsi || 50;
  const rsiPrev = indicators?.rsiPrev || 50;
  const adx = indicators?.adx || 15;
  const adxPrev = indicators?.adxPrev || 15;

  const macdExpanding1 = Math.abs(macd) > Math.abs(macdPrev);
  const macdExpanding2 = Math.abs(macdPrev) > Math.abs(macdPrev2);
  const macdExpandingStreak = macdExpanding1 && macdExpanding2 ? 2 : macdExpanding1 ? 1 : 0;

  const rsiVelocity = Math.abs(rsi - rsiPrev);

  const adxRisingFromLow = adxPrev < 22 && adx > adxPrev;
  const adxConfirmed = adx >= 25;

  let momScore = 0;

  if (macdExpandingStreak >= 2) momScore += 40;
  else if (macdExpandingStreak >= 1) momScore += 20;

  const macdAligned = (macd > 0 && priceUp) || (macd < 0 && !priceUp);
  if (macdAligned) momScore += 15;

  if (priceUp && rsi >= 50 && rsi <= 70) {
    momScore += 20;
    if (rsiVelocity >= 2) momScore += 10;
  } else if (!priceUp && rsi >= 30 && rsi <= 50) {
    momScore += 20;
    if (rsiVelocity >= 2) momScore += 10;
  }

  if (adxConfirmed) momScore += 15;
  else if (adxRisingFromLow) momScore += 8;

  momScore = Math.min(100, momScore);

  const recentVols = vols.slice(-6, -1).filter((v) => v > 0);
  const recentVolAvg =
    recentVols.length > 0 ? recentVols.reduce((a, b) => a + b, 0) / recentVols.length : 1;

  const currentVol = vols[cur];
  const prevVol = vols[prev] || 0;
  const prev2Vol = vols[prev2] || 0;

  const volRatio = recentVolAvg > 0 ? currentVol / recentVolAvg : 1;

  const volExpanding1 = currentVol > prevVol * 1.15;
  const volExpanding2 = prevVol > prev2Vol * 1.1;
  const volExpandingStreak = volExpanding1 && volExpanding2 ? 2 : volExpanding1 ? 1 : 0;

  const volConfirming =
    (priceUp && currentVol > recentVolAvg) || (!priceUp && currentVol > recentVolAvg);

  let volScore = 0;
  if (volRatio >= 3.0) volScore = 95;
  else if (volRatio >= 2.0) volScore = 80;
  else if (volRatio >= 1.5) volScore = 60;
  else if (volRatio >= 1.2) volScore = 40;
  else volScore = 15;

  if (volExpandingStreak >= 2) volScore += 15;
  else if (volExpandingStreak >= 1) volScore += 8;
  if (volConfirming) volScore += 5;
  volScore = Math.min(100, volScore);

  const ignitionScore = Math.round(priceScore * 0.28 + momScore * 0.36 + volScore * 0.36);

  const direction = priceUp ? "BULL" : "BEAR";

  let status;
  let statusColor;
  let description;
  let action;

  if (ignitionScore >= 80) {
    status = "LAUNCH";
    statusColor = "#00ff87";
    description =
      `All 3 engines firing. ` +
      `Price accelerating ${priceAccelRatio.toFixed(1)}x. ` +
      `Volume ${volRatio.toFixed(1)}x recent. ` +
      `MACD expanding ${macdExpandingStreak} bars. ` +
      `This move is real — not a head-fake.`;
    action = direction === "BULL" ? "BUY CALLS NOW — move confirmed" : "BUY PUTS NOW — move confirmed";
  } else if (ignitionScore >= 65) {
    status = "IGNITING";
    statusColor = "#ffd700";
    description =
      `2 of 3 engines firing. ` +
      `Move building but not fully confirmed. ` +
      `Get your order ready. ` +
      `Wait for ${
        volScore < 65 ? "volume to surge" : momScore < 65 ? "MACD to expand one more bar" : "price to accelerate"
      } for full launch.`;
    action = "GET ORDER READY — entry soon";
  } else if (ignitionScore >= 45) {
    status = "WARMING UP";
    statusColor = "#ff8c42";
    description =
      `1 engine starting. ` +
      `No entry yet — setup phase only. ` +
      `Watch for 2+ engines to fire together.`;
    action = "WATCH — not ready yet";
  } else {
    status = "COLD";
    statusColor = "#4a6070";
    description =
      `No engines firing. ` +
      `Volume flat, momentum flat, ` +
      `price not accelerating. ` +
      `Chop — any premium bought here ` +
      `will decay to zero.`;
    action = "STAND ASIDE — paying theta for nothing";
  }

  const last8 = candles.slice(-8);
  const maxVol8 = Math.max(...last8.map((c) => c.volume || c.vol || 0), 1);
  const barData = last8.map((c, i) => ({
    heightPct: Math.round(((c.volume || c.vol || 0) / maxVol8) * 100),
    isUp: (c.close || 0) >= (c.open || c.close || 0),
    isCurrent: i === last8.length - 1,
    ratio: recentVolAvg > 0 ? ((c.volume || c.vol || 0) / recentVolAvg).toFixed(1) : "1.0",
  }));

  return {
    ignitionScore,
    status,
    statusColor,
    direction,
    description,
    action,
    engines: {
      price: {
        score: priceScore,
        ratio: priceAccelRatio.toFixed(1),
        status: priceScore >= 75 ? "FIRING" : priceScore >= 50 ? "BUILDING" : "COLD",
      },
      momentum: {
        score: momScore,
        expandingBars: macdExpandingStreak,
        rsiVelocity: rsiVelocity.toFixed(1),
        adx: adx.toFixed(1),
        status: momScore >= 75 ? "FIRING" : momScore >= 50 ? "BUILDING" : "COLD",
      },
      volume: {
        score: volScore,
        ratio: volRatio.toFixed(1),
        expandingBars: volExpandingStreak,
        status: volScore >= 75 ? "FIRING" : volScore >= 50 ? "BUILDING" : "COLD",
      },
    },
    barData,
  };
}

window.calculateIgnition = calculateIgnition;


/**
 * HUD v1 DOM: #page-hud-* , #hud-tactical-cards, #hud-scan-regime-inner, #hud-positions-list,
 * #hud-logged-trades, #hud-alert-log, #health-banner
 */
(function initSohelatorVerbatimNeon() {
  var SCAN_URL = "/api/scan";
  var LOG_URL = "/api/log-trade";
  var SCAN_HOOK = "/api/scan";
  var POLL_SCAN_MS = 60000;
  var POLL_OPEN_MS = 30000;
  var SPY_LEVELS_SYM = "SPY";
  var EXPENSIVE_SLOTS_ET_MIN = [495, 565, 585, 660, 840, 960];

  var pollScanTimer = null;
  var pollOpenTimer = null;
  var spyLevelsTimer = null;
  var hudClockTimer = null;
  var positionTtiTimer = null;

  function timeInTrade(openedAt) {
    var ms = Date.now() - new Date(openedAt).getTime();
    if (!isFinite(ms) || ms < 0) return "—";
    var h = Math.floor(ms / 3600000);
    var m = Math.floor((ms % 3600000) / 60000);
    return h > 0 ? h + "h " + m + "m" : m + "m";
  }

  function formatAlertTime(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    if (sameDay) return d.toTimeString().slice(0, 8);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " +
      d.toTimeString().slice(0, 5)
    );
  }

  function showHudPage(which) {
    var w = which === "learning" ? "brief" : which;
    var ids = {
      home: "page-hud-home",
      pos: "page-hud-pos",
      scan: "page-hud-scan",
      brief: "page-hud-brief",
      sys: "page-hud-sys",
    };
    Object.keys(ids).forEach(function (k) {
      var el = document.getElementById(ids[k]);
      if (el) el.classList.toggle("active", k === w);
    });
    document.querySelectorAll(".hud-bottom-nav button[data-hud-tab]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-hud-tab") === w);
    });
  }
  window.__sohelShowHudPage = showHudPage;

  function tickHudClock() {
    var el = document.getElementById("hud-clock");
    if (!el) return;
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date());
    var hh = "";
    var mm = "";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") hh = parts[i].value;
      if (parts[i].type === "minute") mm = parts[i].value;
    }
    el.textContent = hh + ":" + mm;
  }

  function updateHudScanLast() {
    var span = document.getElementById("hud-scan-last");
    if (!span) return;
    var okAt = window.__sohelLastScanOkAt;
    if (okAt == null) {
      span.textContent = "—";
      return;
    }
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(new Date(okAt));
    var t = "";
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour" || parts[i].type === "minute" || parts[i].type === "second") {
        t += (t ? ":" : "") + parts[i].value;
      }
    }
    span.textContent = t + " ET";
  }

  var CHECKPOINTS = [
    { key: "premarket", t: "08:30", lab: "PRE", slotMin: 8 * 60 + 30 },
    { key: "scan-925", t: "09:25", lab: "OPEN", slotMin: 9 * 60 + 25 },
    { key: "scan-955", t: "09:55", lab: "MID-AM", slotMin: 9 * 60 + 55 },
    { key: "cheap-monitor", t: "11:00", lab: "MID", slotMin: 11 * 60 },
    { key: "scanner", t: "13:00", lab: "PM", slotMin: 13 * 60 },
    { key: "cheap-monitor2", t: "15:00", lab: "LATE", slotMin: 15 * 60 },
    { key: "scan-eod", t: "16:05", lab: "EOD", slotMin: 16 * 60 + 5 },
  ];

  function ymdEt(ms) {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(ms));
  }

  function renderCheckpointStrip(jobHealth, premarketAsOfMs, lastScanMs) {
    var host = document.getElementById("hud-checkpoint-strip");
    if (!host) return;
    var now = Date.now();
    var todayYmd = ymdEt(now);
    function lastOkMs(key) {
      if (key === "premarket" && premarketAsOfMs) {
        return ymdEt(premarketAsOfMs) === todayYmd ? premarketAsOfMs : 0;
      }
      if (key === "cheap-monitor2") {
        var j = jobHealth && jobHealth["cheap-monitor"];
        return j && j.lastOk && ymdEt(j.lastOk) === todayYmd && minutesEt(new Date(j.lastOk)) >= 14 * 60 + 30
          ? j.lastOk
          : 0;
      }
      if (key === "cheap-monitor") {
        var j2 = jobHealth && jobHealth["cheap-monitor"];
        if (!j2 || !j2.lastOk || ymdEt(j2.lastOk) !== todayYmd) return 0;
        var m = minutesEt(new Date(j2.lastOk));
        if (m >= 10 * 60 + 30 && m < 14 * 60 + 30) return j2.lastOk;
        return 0;
      }
      var row = jobHealth && jobHealth[key];
      return row && row.lastOk && ymdEt(row.lastOk) === todayYmd ? row.lastOk : 0;
    }
    function minutesEt(d) {
      var parts = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "numeric",
        hour12: false,
      }).formatToParts(d);
      var h = 0;
      var m = 0;
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === "hour") h = parseInt(parts[i].value, 10);
        if (parts[i].type === "minute") m = parseInt(parts[i].value, 10);
      }
      return h * 60 + m;
    }
    var nowMin = minutesEt(new Date());
    var done = CHECKPOINTS.map(function (c) {
      var ok = 0;
      if (c.key === "scanner" && lastScanMs && ymdEt(lastScanMs) === todayYmd) {
        var sm = minutesEt(new Date(lastScanMs));
        if (sm >= 12 * 60 + 15 && sm <= 14 * 60 + 45) ok = lastScanMs;
      }
      if (!ok) ok = lastOkMs(c.key);
      return { slotMin: c.slotMin, ok: ok, lab: c.lab, t: c.t };
    });
    var nextIdx = -1;
    var i;
    for (i = 0; i < done.length; i++) {
      if (!done[i].ok && nowMin >= done[i].slotMin - 5) {
        nextIdx = i;
        break;
      }
    }
    if (nextIdx < 0) {
      for (i = 0; i < done.length; i++) {
        if (!done[i].ok) {
          nextIdx = i;
          break;
        }
      }
    }
    var html = "";
    for (var n = 0; n < CHECKPOINTS.length; n++) {
      var c = CHECKPOINTS[n];
      if (n > 0) html += '<div class="hud-cp-line"></div>';
      var cls = "hud-cp-node";
      if (done[n].ok) cls += " hud-cp-node--done";
      else if (n === nextIdx) cls += " hud-cp-node--next";
      html +=
        '<div class="' +
        cls +
        '"><div class="hud-cp-pip"></div><div class="hud-cp-time">' +
        esc(c.t) +
        '</div><div class="hud-cp-label">' +
        esc(c.lab) +
        "</div></div>";
    }
    host.innerHTML = html;
  }

  function fetchHudAuxiliary() {
    fetch("/api/premarket", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (snap) {
        if (snap && snap.asOf) {
          preAs = Date.parse(snap.asOf) || 0;
          window.__sohelPremarketAsOf = preAs;
        }
        var body = document.getElementById("hud-intel-body");
        var tm = document.getElementById("hud-intel-time");
        var brief = snap && snap.aiBrief ? String(snap.aiBrief) : "";
        if (body) {
          body.textContent = brief || "(No Grok brief yet.)";
          body.style.whiteSpace = "pre-wrap";
        }
        if (tm && snap && snap.asOf) {
          tm.textContent = formatAlertTime(snap.asOf);
        }
        fetch("/api/health", { cache: "no-store" })
          .then(function (r) {
            return r.json();
          })
          .then(function (h) {
            var jh = (h && h.jobHealth) || {};
            renderCheckpointStrip(
              jh,
              window.__sohelPremarketAsOf,
              window.__sohelLastScanOkAt
            );
            window.__sohelLastHealthJson = h;
          })
          .catch(function () {
            renderCheckpointStrip({}, window.__sohelPremarketAsOf, window.__sohelLastScanOkAt);
          });
      })
      .catch(function () {
        renderCheckpointStrip({}, 0, window.__sohelLastScanOkAt);
      });
  }

  window.__sohelFetchSysHealth = function () {
    var pre = document.getElementById("hud-sys-health-json");
    fetch("/api/health", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (h) {
        if (pre) pre.textContent = JSON.stringify(h, null, 2);
        window.__sohelLastHealthJson = h;
        renderCheckpointStrip(
          (h && h.jobHealth) || {},
          window.__sohelPremarketAsOf,
          window.__sohelLastScanOkAt
        );
      })
      .catch(function (e) {
        if (pre) pre.textContent = String(e.message || e);
      });
  };

  function updateRegimeBadgeFromScan(j) {
    var badge = document.getElementById("hud-regime-badge");
    var txt = document.getElementById("hud-regime-text");
    if (!badge || !txt || !j || !Array.isArray(j.alerts)) return;
    var list = j.alerts.filter(function (a) {
      return (Number(a.score) || 0) >= 65;
    });
    if (!list.length) {
      badge.classList.remove("hud-regime--bull", "hud-regime--bear");
      badge.classList.add("hud-regime--neutral");
      txt.textContent = "—";
      return;
    }
    list.sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });
    var top = list[0];
    var bull = String(top.direction || "").toLowerCase() !== "short";
    badge.classList.remove("hud-regime--bull", "hud-regime--bear", "hud-regime--neutral");
    if (bull) {
      badge.classList.add("hud-regime--bull");
      txt.textContent = "BULL";
    } else {
      badge.classList.add("hud-regime--bear");
      txt.textContent = "BEAR";
    }
  }

  function renderHudStats(j) {
    var n = !j || !Array.isArray(j.alerts) ? 0 : j.alerts.length;
    var elA = document.getElementById("hud-stat-alerts");
    var elW = document.getElementById("hud-stat-win");
    var elE = document.getElementById("hud-stat-edge");
    var elS = document.getElementById("hud-stat-setups");
    var b7 = j && j.meta && j.meta.backtest7d;
    if (elA) elA.textContent = String(n);
    if (elW)
      elW.textContent =
        b7 && b7.winRate != null ? Math.round(Number(b7.winRate) * 100) + "%" : "—";
    if (elE)
      elE.textContent =
        b7 && b7.ev != null ? Number(b7.ev).toFixed(2) : "—";
    if (elS)
      elS.textContent =
        b7 && b7.totalSetups != null ? String(b7.totalSetups) : "—";
  }

  function renderSessionPnlFromPositions(positions) {
    var el = document.getElementById("hud-session-pnl");
    if (!el) return;
    if (!positions || !positions.length) {
      el.textContent = "$0.00";
      el.classList.remove("hud-hero-pnl--neg");
      return;
    }
    var sum = 0;
    positions.forEach(function (p) {
      var st = String(p.status || "");
      if (st.indexOf("EXIT") !== -1) return;
      sum += Number(p.pnlDollar) || 0;
    });
    var s = (sum >= 0 ? "+" : "") + "$" + Math.abs(sum).toFixed(2);
    el.textContent = sum < 0 ? "-" + "$" + Math.abs(sum).toFixed(2) : s;
    el.classList.toggle("hud-hero-pnl--neg", sum < 0);
  }

  function posAccentFromStatus(status) {
    var s = String(status || "");
    if (s.indexOf("EXIT") !== -1) return "exit";
    if (s.indexOf("DANGER") !== -1) return "danger";
    if (s.indexOf("LIVE") !== -1) return "live";
    return "hold";
  }

  function renderPositionTrackerList(positions) {
    var host = document.getElementById("hud-positions-list");
    if (!host) return;
    if (!positions || !positions.length) {
      host.innerHTML = '<p class="hint">No open positions in tracker.</p>';
      return;
    }
    var open = positions.filter(function (p) {
      return String(p.status || "").indexOf("EXIT") === -1;
    });
    if (!open.length) {
      host.innerHTML = '<p class="hint">No active positions (all exited).</p>';
      return;
    }
    host.innerHTML = open
      .map(function (p) {
        var sym = esc(String(p.symbol || "—").toUpperCase());
        var pct = p.pnlPct != null && isFinite(Number(p.pnlPct)) ? Number(p.pnlPct).toFixed(2) : "—";
        var acc = posAccentFromStatus(p.status);
        var acCls =
          acc === "live"
            ? "hud-pos-ac--live"
            : acc === "danger"
              ? "hud-pos-ac--danger"
              : acc === "exit"
                ? "hud-pos-ac--exit"
                : "hud-pos-ac--hold";
        var barCls =
          acc === "live"
            ? "hud-pos-bar--live"
            : acc === "danger"
              ? "hud-pos-bar--danger"
              : acc === "exit"
                ? "hud-pos-bar--exit"
                : "hud-pos-bar--hold";
        var dir = String(p.direction || "long").toUpperCase();
        var ent = p.entryPrice != null ? fmtPx(p.entryPrice) : "—";
        var now = p.currentPrice != null ? fmtPx(p.currentPrice) : "—";
        var opt =
          p.suggestedOption && p.suggestedOption.description
            ? esc(String(p.suggestedOption.description))
            : "";
        var opened = p.openedAtIso || p.openedAt;
        var tti = timeInTrade(opened);
        var prog = Math.min(100, Math.max(4, 50 + (Number(p.pnlPct) || 0) * 2));
        return (
          '<div class="hud-pos-card" data-pos-id="' +
          esc(p.id) +
          '"><div class="hud-pos-ac ' +
          acCls +
          '"></div><div class="hud-pos-in"><div class="hud-pos-row1"><span class="hud-pos-sym">' +
          sym +
          '</span><span class="hud-pos-pnl ' +
          (Number(p.pnlPct) < 0 ? "hud-pos-pnl--neg" : "") +
          '">' +
          esc(pct) +
          '%</span></div><div class="hud-pos-detail">' +
          esc(dir) +
          " · ENTRY " +
          esc(ent) +
          " · NOW " +
          esc(now) +
          (opt ? " · " + opt : "") +
          '</div><div class="hud-pos-meta"><span class="hud-pill">' +
          esc(String(p.status || "—")) +
          '</span><span class="hud-pos-tti" data-opened-at="' +
          esc(String(opened || "")) +
          '">IN TRADE · ' +
          esc(tti) +
          '</span></div><div class="hud-pos-bar ' +
          barCls +
          '"><i style="width:' +
          prog +
          '%"></i></div></div></div>'
        );
      })
      .join("");
  }

  function updateAllPositionTimeInTrade() {
    document.querySelectorAll(".hud-pos-tti[data-opened-at]").forEach(function (el) {
      var o = el.getAttribute("data-opened-at");
      el.textContent = "IN TRADE · " + timeInTrade(o);
    });
  }

  function fetchPositionTracker() {
    fetch("/api/position-tracker", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        var list = (j && j.positions) || [];
        window.__sohelPositionTrackerList = list;
        renderPositionTrackerList(list);
        renderSessionPnlFromPositions(list);
      })
      .catch(function () {
        var host = document.getElementById("hud-positions-list");
        if (host) host.innerHTML = '<p class="hint">Position tracker unavailable.</p>';
      });
  }

  function alertIsoFromTrackerRow(a) {
    if (a.alertedAtIso) return a.alertedAtIso;
    if (a.timestamp != null && isFinite(Number(a.timestamp))) {
      return new Date(Number(a.timestamp)).toISOString();
    }
    return "";
  }

  function renderHudAlertLog(rows) {
    var host = document.getElementById("hud-alert-log");
    if (!host) return;
    if (!rows || !rows.length) {
      host.innerHTML = '<p class="hint">No alert history in blob store yet.</p>';
      return;
    }
    var sorted = rows.slice().sort(function (a, b) {
      var ta = Number(a.timestamp) || 0;
      var tb = Number(b.timestamp) || 0;
      return tb - ta;
    });
    host.innerHTML = sorted
      .map(function (a) {
        var iso = alertIsoFromTrackerRow(a);
        var ts = formatAlertTime(iso || (a.timestamp ? new Date(Number(a.timestamp)).toISOString() : ""));
        var sym = esc(String(a.ticker || a.symbol || "—").toUpperCase());
        var sc = a.score != null ? Math.round(Number(a.score)) : "—";
        var px =
          a.underlyingAtAlert != null && isFinite(Number(a.underlyingAtAlert))
            ? Number(a.underlyingAtAlert).toFixed(2)
            : a.price != null
              ? Number(a.price).toFixed(2)
              : "—";
        var isPut =
          a.direction === "put" ||
          String(a.option && a.option.optType || "").toLowerCase() === "put";
        var isCall =
          a.direction === "call" ||
          String(a.option && a.option.optType || "").toLowerCase() === "call";
        var side = isPut ? "SHORT" : isCall ? "LONG" : "SKIP";
        var bcls =
          side === "LONG" ? "hud-log-badge--long" : side === "SHORT" ? "hud-log-badge--short" : "hud-log-badge--skip";
        return (
          '<div class="hud-log-row" data-alert-log="1"><span class="hud-log-ts">' +
          esc(ts) +
          '</span><span class="hud-log-sym">' +
          sym +
          '</span><span class="hud-log-meta">SCR ' +
          esc(String(sc)) +
          " · $" +
          esc(px) +
          '</span><span class="hud-log-badge ' +
          bcls +
          '">' +
          esc(side) +
          "</span></div>"
        );
      })
      .join("");
  }

  function fetchHudAlertTracker() {
    fetch("/api/alert-tracker", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (j) {
        renderHudAlertLog((j && j.alerts) || []);
      })
      .catch(function () {
        var host = document.getElementById("hud-alert-log");
        if (host) host.innerHTML = '<p class="hint">Alert tracker unavailable.</p>';
      });
  }

  var scanStatusLabel = "—";
  var scanStatusOk = true;
  var openStatusLabel = "—";
  var openStatusOk = true;

  function esc(s) {
    if (s == null || s === "") return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function normList(x) {
    if (x == null) return [];
    return Array.isArray(x) ? x : [x];
  }

  function ymd(d) {
    return d.toISOString().slice(0, 10);
  }

  function tradierApi(path, method, params) {
    return fetch("/api/tradier", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: path,
        method: method || "GET",
        params: params || {},
        body: {},
      }),
      cache: "no-store",
    }).then(function (r) {
      return r.json();
    });
  }

  function classicPivots(h, l, c) {
    var H = Number(h);
    var L = Number(l);
    var C = Number(c);
    if (!isFinite(H) || !isFinite(L) || !isFinite(C)) return null;
    var pp = (H + L + C) / 3;
    return { pp: pp, r1: 2 * pp - L, s1: 2 * pp - H };
  }

  function fmtPx(x) {
    if (x == null || !isFinite(Number(x))) return "—";
    return "$" + Number(x).toFixed(2);
  }

  function firstQuote(data) {
    var raw = data && data.quotes && (data.quotes.quote || data.quotes);
    var arr = normList(raw);
    return arr[0] || null;
  }

  function clearLevelHighlights() {
    document.querySelectorAll("#regime-spy-slot .level-cell").forEach(function (cell) {
      cell.classList.remove("sohel-near-level");
    });
  }

  function maybeHighlightLevel(last, levelPx, levelValId) {
    if (!isFinite(last) || !isFinite(levelPx) || !levelValId) return;
    var thr = Math.abs(last * 0.0015);
    if (Math.abs(last - levelPx) > thr) return;
    var el = document.getElementById(levelValId);
    var cell = el && el.closest ? el.closest(".level-cell") : null;
    if (cell) cell.classList.add("sohel-near-level");
  }

  function refreshSpyLevels() {
    var sym = SPY_LEVELS_SYM;
    var slot = document.getElementById("regime-spy-slot");
    if (!slot) return;
    tradierApi("/v1/markets/history", "GET", {
      symbol: sym,
      interval: "daily",
      start: ymd(new Date(Date.now() - 420 * 86400000)),
    })
      .then(function (data) {
        var days = normList(data && data.history && data.history.day);
        if (!days.length) return Promise.reject(new Error("no daily"));
        var prev = days.length >= 2 ? days[days.length - 2] : days[days.length - 1];
        var piv = classicPivots(prev.high, prev.low, prev.close);
        return tradierApi("/v1/markets/quotes", "GET", {
          symbols: sym,
          greeks: "false",
        }).then(function (qd) {
          var q = firstQuote(qd);
          var last =
            q &&
            (parseFloat(q.last) ||
              parseFloat(q.close) ||
              parseFloat(q.bid) ||
              NaN);
          clearLevelHighlights();
          var lastStr = isFinite(last) ? fmtPx(last) : "—";
          var note =
            prev && prev.date
              ? "Prior bar " + String(prev.date) + " → PP / R1 / S1 vs live " + sym + "."
              : "";
          var r1s = piv ? fmtPx(piv.r1) : "—";
          var pps = piv ? fmtPx(piv.pp) : "—";
          var s1s = piv ? fmtPx(piv.s1) : "—";
          slot.innerHTML =
            '<div class="sohel-spy-row"><span class="lab">SPY LAST</span><span class="px" id="spy-price-val">' +
            esc(lastStr) +
            '</span></div><div class="levels-3">' +
            '<div class="level-cell r1"><span class="lv">R1</span><span class="num" id="spy-r1-val">' +
            esc(r1s) +
            '</span></div><div class="level-cell pp"><span class="lv">PIVOT</span><span class="num" id="spy-pp-val">' +
            esc(pps) +
            '</span></div><div class="level-cell s1"><span class="lv">S1</span><span class="num" id="spy-s1-val">' +
            esc(s1s) +
            "</span></div></div>" +
            (note ? '<p class="sohel-level-note">' + esc(note) + "</p>" : "");
          if (piv && isFinite(last)) {
            maybeHighlightLevel(last, piv.r1, "spy-r1-val");
            maybeHighlightLevel(last, piv.pp, "spy-pp-val");
            maybeHighlightLevel(last, piv.s1, "spy-s1-val");
          }
        });
      })
      .catch(function () {
        if (slot)
          slot.innerHTML =
            '<p class="hint">SPY levels unavailable (quote/history).</p>';
      });
  }

  /* SOHELATOR blueprint — full ALIGN.ICS v3 template adoption (Prompt 15) */
  function refreshHeaderQuotes() {
    tradierApi("/v1/markets/quotes", "GET", {
      symbols: "SPY,VIX",
      greeks: "false",
    })
      .then(function (qd) {
        var quotes = normList(qd.quotes && (qd.quotes.quote || qd.quotes));
        quotes.forEach(function (q) {
          var sym = String(q.symbol || "")
            .toUpperCase()
            .replace(/^\$/, "");
          var last = parseFloat(q.last || q.close || q.bid || NaN);
          var s = isFinite(last)
            ? sym.indexOf("VIX") !== -1
              ? last.toFixed(2)
              : "$" + last.toFixed(2)
            : "—";
          if (sym === "SPY") {
            var el = document.getElementById("hdr-spy");
            if (el) el.textContent = s;
          }
          if (sym === "VIX") {
            var e2 = document.getElementById("hdr-vix");
            if (e2) e2.textContent = s;
          }
        });
      })
      .catch(function () {});
  }

  function updateRiskPillFromScan(j) {
    var el = document.getElementById("hdr-risk");
    if (!el) return;
    if (!j || j.success === false || !Array.isArray(j.alerts)) {
      el.textContent = "RISK —";
      return;
    }
    var maxS = j.alerts.reduce(function (m, a) {
      return Math.max(m, Number(a.score) || 0);
    }, 0);
    if (maxS >= 80) el.textContent = "RISK ON";
    else if (maxS >= 60) el.textContent = "WATCHING";
    else el.textContent = "RISK OFF";
  }

  function updateHdrLiveFromPanel() {
    var pill = document.getElementById("hdr-live-pill");
    if (!pill) return;
    pill.textContent = scanStatusOk ? "LIVE" : "WARN";
    pill.style.color = scanStatusOk ? "#00ff88" : "#ffaa00";
    pill.style.borderColor = scanStatusOk ? "rgba(0,255,136,0.5)" : "rgba(255,170,0,0.6)";
  }

  /** Short market-state copy only — full Grok / scanner dump removed from LIVE (watchlist) tab */
  function regimeBriefHtml(j) {
    if (!j || j.success === false) {
      return (
        '<div class="regime-brief-wrap"><p class="regime-brief hint">' +
        esc(j && j.error ? String(j.error) : "Waiting for scanner…") +
        "</p></div>"
      );
    }
    var meta = j.meta || {};
    var st = j.status || "ok";
    var s1 = "";
    if (st === "after_hours") {
      s1 =
        String(meta.optionsSessionNote || "").trim() ||
        "US equity options are closed until the next session (9:30–16:00 ET Mon–Fri).";
    } else if (st === "outside_window") {
      s1 =
        "Weekday cheap scan — AI co-pilot runs on expensive passes during 8:00–16:00 ET.";
    } else {
      s1 =
        j.mode === "expensive"
          ? "Session live — full scan with Grok on this pass when configured."
          : "Session live — cheap scan; Grok summaries appear on expensive-window passes.";
    }
    if (s1.length > 220) s1 = s1.slice(0, 217) + "…";
    var n = Array.isArray(j.alerts) ? j.alerts.length : 0;
    var b7 = meta.backtest7d;
    var s2 =
      "This refresh: " +
      n +
      " setup(s) on the board.";
    if (b7 && b7.ev != null) {
      s2 +=
        " 7d model edge ~" +
        Number(b7.ev).toFixed(2) +
        ", ~" +
        (b7.winRate != null
          ? Math.round(Number(b7.winRate) * 100)
          : "—") +
        "% wins" +
        (b7.totalSetups != null ? " over " + b7.totalSetups + " setups." : ".");
    }
    if (s2.length > 280) s2 = s2.slice(0, 277) + "…";
    return (
      '<div class="regime-brief-wrap">' +
      '<p class="regime-brief">' +
      esc(s1) +
      '</p><p class="regime-brief regime-brief--dim">' +
      esc(s2) +
      "</p></div>"
    );
  }

  function renderHomeFromScan(j) {
    var regimeEl = document.getElementById("hud-scan-regime-inner");
    var tacHost = document.getElementById("hud-tactical-cards");
    var badge = document.getElementById("nav-hud-home-badge");
    if (!regimeEl || !tacHost) return;

    var FIRING_MIN = 80;
    var HEATING_MIN = 60;
    var HEATING_MAX = 79;

    function indTagsHtml(a) {
      if (!a || !a.details) return "";
      var d = a.details;
      var tags = [];
      var vr = Number(d.volRatio);
      if (isFinite(vr)) {
        if (vr >= 2)
          tags.push({ cls: "tag-vol-bull", t: "VOL " + vr.toFixed(1) + "x" });
        else if (vr < 0.9)
          tags.push({ cls: "tag-vol-bear", t: "VOL DRY" });
        else tags.push({ cls: "tag-vol", t: "VOL " + vr.toFixed(1) + "x" });
      }
      var mh = Number(d.macdHist);
      if (isFinite(mh)) {
        if (mh > 0) tags.push({ cls: "tag-macd-bull", t: "MACD BULL" });
        else tags.push({ cls: "tag-macd-bear", t: "MACD BEAR" });
      }
      var adx = Number(d.adx);
      if (isFinite(adx)) {
        if (adx < 22)
          tags.push({
            cls: "tag-adx-chop",
            t: "ADX " + Math.round(adx) + " CHOP",
          });
        else tags.push({ cls: "tag-adx", t: "ADX " + Math.round(adx) });
      }
      var rsi = Number(d.rsi);
      if (isFinite(rsi)) {
        tags.push({ cls: "tag-rsi", t: "RSI " + Math.round(rsi) });
      }
      if (!tags.length) return "";
      return (
        '<div class="align-ind-row">' +
        tags
          .map(function (x) {
            return (
              '<span class="sohel-ind-tag ' +
              x.cls +
              '">' +
              esc(x.t) +
              "</span>"
            );
          })
          .join("") +
        "</div>"
      );
    }

    function hudTacticalCardHtml(a, idx) {
      var sym = esc(String(a.symbol || "—").toUpperCase());
      var sc = a.score != null ? Math.round(Number(a.score)) : 0;
      var tierCls = sc >= 80 ? "hud-tcard--hi" : sc >= 65 ? "hud-tcard--mid" : "hud-tcard--lo";
      var long = String(a.direction || "long").toLowerCase() !== "short";
      var dirTag = long
        ? '<span class="hud-tag hud-tag--dir-long">LONG</span>'
        : '<span class="hud-tag hud-tag--dir-short">SHORT</span>';
      var play = esc(String(a.playTypeLabel || a.playType || "SETUP"));
      var pt = a.last != null && isFinite(Number(a.last)) ? "$" + Number(a.last).toFixed(2) : "—";
      var ms = a.alertedAt || (a.alertedAtIso ? Date.parse(a.alertedAtIso) : 0);
      var timeStr = "—";
      if (ms) {
        timeStr =
          new Intl.DateTimeFormat("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          }).format(new Date(ms)) + " ET";
      }
      var verdict = String(a.aiVerdict || a.drivingText || "").trim();
      if (verdict.length > 480) verdict = verdict.slice(0, 477) + "…";
      var ent = a.entry != null && isFinite(Number(a.entry)) ? "$" + Number(a.entry).toFixed(2) : "—";
      var stp = a.stop != null && isFinite(Number(a.stop)) ? "$" + Number(a.stop).toFixed(2) : "—";
      var tg = a.target != null && isFinite(Number(a.target)) ? "$" + Number(a.target).toFixed(2) : "—";
      var o = a.suggestedOption;
      var optLine;
      if (o && o.strike != null && o.expiration) {
        var letter = String(o.right || "").toLowerCase() === "put" ? "P" : "C";
        var stk = Number(o.strike);
        var playS =
          (Math.abs(stk - Math.round(stk)) < 1e-6 ? String(Math.round(stk)) : stk.toFixed(2)) + letter;
        var mid =
          o.mid != null && isFinite(Number(o.mid)) ? "$" + Number(o.mid).toFixed(2) : "—";
        var del =
          o.delta != null && isFinite(Number(o.delta)) ? Number(o.delta).toFixed(2) : "—";
        optLine =
          '<div class="hud-tcard-opt">' +
          esc(playS) +
          " · exp " +
          esc(String(o.expiration)) +
          " · mid " +
          esc(mid) +
          " · Δ" +
          esc(del) +
          "</div>";
      } else {
        optLine =
          '<div class="hud-tcard-opt" style="opacity:0.65">Option chain n/a — refresh scan</div>';
      }
      return (
        '<div class="hud-tcard ' +
        tierCls +
        '"><div class="hud-tcard-ac"></div><div class="hud-tcard-in"><div class="hud-tcard-score">' +
        esc(String(sc)) +
        '</div><div class="hud-tcard-head"><span class="hud-tcard-sym">' +
        sym +
        '</span><div class="hud-tcard-px">' +
        esc(pt) +
        "<br/>" +
        esc(timeStr) +
        '</div></div><div class="hud-tcard-tags">' +
        dirTag +
        '<span class="hud-tag">' +
        play +
        '</span></div><div class="hud-tcard-verdict">' +
        esc(verdict || "(no verdict)") +
        '</div><div class="hud-est-grid"><div class="hud-est"><span class="k">ENTRY</span><div class="v">' +
        esc(ent) +
        '</div></div><div class="hud-est hud-est--stop"><span class="k">STOP</span><div class="v">' +
        esc(stp) +
        '</div></div><div class="hud-est hud-est--tgt"><span class="k">TARGET</span><div class="v">' +
        esc(tg) +
        "</div></div></div>" +
        optLine +
        indTagsHtml(a) +
        '<div class="hud-tcard-actions"><button type="button" class="hud-btn-enter" data-sohel-enter="tactical:' +
        idx +
        '">ENTER NOW</button><button type="button" class="hud-btn-wait" data-sohel-wait="1">WAIT RETEST</button><button type="button" class="hud-btn-skip">SKIP</button></div></div></div>'
      );
    }

    if (!j || j.success === false) {
      regimeEl.innerHTML =
        '<div id="sohel-regime-header"></div><p class="hint">' +
        esc(j && j.error ? "Scanner: " + String(j.error) : "Waiting for scanner…") +
        "</p>";
      tacHost.innerHTML = "";
      if (badge) {
        badge.setAttribute("data-count", "0");
        badge.textContent = "0";
      }
      window.__sohelAlignFiring = [];
      window.__sohelAlignHeating = [];
      window.__sohelTacticalList = [];
      return;
    }

    var meta = j.meta || {};
    var st = j.status || "ok";
    var pill =
      st === "after_hours"
        ? "AFTER HOURS"
        : st === "outside_window"
          ? "OUTSIDE 8–4 ET"
          : String(j.mode || "cheap").toUpperCase();

    regimeEl.innerHTML =
      '<div id="sohel-regime-header" class="sohel-regime-top"><span class="sohel-pill">' +
      esc(pill) +
      '</span></div><div id="regime-spy-slot"><p class="hint">Loading SPY…</p></div>' +
      regimeBriefHtml(j);

    refreshSpyLevels();
    refreshHeaderQuotes();

    var alerts = Array.isArray(j.alerts) ? j.alerts : [];
    if (st === "after_hours") {
      tacHost.innerHTML =
        '<p class="hint">' +
        esc(
          meta.optionsSessionNote ||
            "Options session closed — 9:30–16:00 ET Mon–Fri."
        ) +
        "</p>";
      if (badge) {
        badge.setAttribute("data-count", "0");
        badge.textContent = "0";
      }
      window.__sohelAlignFiring = [];
      window.__sohelAlignHeating = [];
      window.__sohelTacticalList = [];
      return;
    }

    var firing = alerts
      .filter(function (a) {
        return (Number(a.score) || 0) >= FIRING_MIN;
      })
      .sort(function (a, b) {
        return (Number(b.score) || 0) - (Number(a.score) || 0);
      });
    var heating = alerts
      .filter(function (a) {
        var s = Number(a.score) || 0;
        return s >= HEATING_MIN && s <= HEATING_MAX;
      })
      .sort(function (a, b) {
        return (Number(b.score) || 0) - (Number(a.score) || 0);
      });

    window.__sohelAlignFiring = firing;
    window.__sohelAlignHeating = heating;

    var tactical = firing.concat(heating).sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });
    window.__sohelTacticalList = tactical;

    var nActive = tactical.length;
    if (badge) {
      badge.setAttribute("data-count", String(nActive));
      badge.textContent = String(nActive);
    }

    tacHost.innerHTML = tactical.length
      ? tactical
          .map(function (a, i) {
            return hudTacticalCardHtml(a, i);
          })
          .join("")
      : '<p class="hint">No tactical setups (need score ≥ ' + HEATING_MIN + ").</p>";
  }
  function formatAlertTimeEt(a) {
    var ms = 0;
    if (a.alertedAt != null && isFinite(Number(a.alertedAt))) {
      ms = Number(a.alertedAt);
    } else if (a.alertedAtIso) {
      ms = Date.parse(a.alertedAtIso) || 0;
    }
    if (!ms) {
      ms =
        Date.parse(a.ts || a.timestamp || a.createdAt || a.alertAt || "") ||
        0;
    }
    if (!ms) return "—";
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    }).format(new Date(ms)) + " ET";
  }

  function alertOptionLine(a) {
    if (!a || !a.suggestedOption) return "";
    var o = a.suggestedOption;
    if (o.strike == null || !o.expiration) return "";
    var r = String(o.right || "").toLowerCase() === "put" ? "PUT" : "CALL";
    var stk = Number(o.strike);
    var stks =
      Math.abs(stk - Math.round(stk)) < 1e-6
        ? String(Math.round(stk))
        : stk.toFixed(2);
    var mid =
      o.mid != null && isFinite(Number(o.mid))
        ? " · mid ~$" + Number(o.mid).toFixed(2)
        : "";
    var del =
      o.delta != null && isFinite(Number(o.delta))
        ? " · Δ" + Number(o.delta).toFixed(2)
        : "";
    return (
      esc(r) +
      " $" +
      esc(stks) +
      " · exp " +
      esc(String(o.expiration)) +
      esc(mid) +
      esc(del)
    );
  }

  function setPanelStatus(label, ok) {
    scanStatusLabel = label;
    scanStatusOk = ok;
    updateHealthBanner();
    updateHdrLiveFromPanel();
  }

  function setOpenStatus(label, ok) {
    openStatusLabel = label;
    openStatusOk = ok;
    updateHealthBanner();
  }

  function renderOpenTrades(list) {
    var host = document.getElementById("hud-logged-trades");
    if (!host) return;
    if (!list || !list.length) {
      host.innerHTML =
        '<p class="tm-muted" style="margin:0;">No open trades logged.</p>';
      return;
    }
    host.innerHTML = list
      .map(function (t) {
        var sym = esc(t.symbol || "—");
        var r = t.livePnlR != null ? Number(t.livePnlR).toFixed(3) : "—";
        var pct = t.livePnlPct != null ? Number(t.livePnlPct).toFixed(2) : "—";
        var g =
          t.greeks && t.greeks.placeholder
            ? "<div class=\"tm-muted\">Greeks: " + esc(t.greeks.note || "placeholder") + "</div>"
            : "";
        var actions = Array.isArray(t.actions) ? t.actions : [];
        var actionHtml = actions
          .map(function (act) {
            return (
              "<button type=\"button\" class=\"tm-btn-action\" data-tm-aid=\"" +
              esc(act.id) +
              "\" data-tm-tid=\"" +
              esc(t.id) +
              "\" title=\"" +
              esc(act.reason || "") +
              "\">" +
              esc(act.label) +
              "</button>"
            );
          })
          .join("");
        var snap = t.alertSnapshot || {};
        var alertCtx = "";
        var und =
          t.underlyingAtAlert != null
            ? t.underlyingAtAlert
            : snap.underlyingAtAlert != null
              ? snap.underlyingAtAlert
              : snap.last;
        var atIso = t.alertedAtIso || snap.alertedAtIso;
        var atMs = t.alertedAt || snap.alertedAt;
        var et = "";
        if (atMs && isFinite(Number(atMs))) {
          et = formatAlertTimeEt({ alertedAt: atMs });
        } else if (atIso) {
          et = formatAlertTimeEt({ alertedAtIso: atIso });
        }
        if (et && et !== "—") {
          var optSnap = snap.suggestedOption;
          var optS = "";
          if (
            optSnap &&
            optSnap.strike != null &&
            optSnap.expiration
          ) {
            optS =
              " · " +
              alertOptionLine({ suggestedOption: optSnap });
          }
          alertCtx =
            '<div class="ap-time tm-muted" style="margin-bottom:8px;">Signal time ' +
            esc(et) +
            (und != null && isFinite(Number(und))
              ? " · underlying $" + esc(Number(und).toFixed(2)) + " at alert"
              : "") +
            optS +
            "</div>";
        }
        return (
          "<div class=\"tm-open-card\" data-tm-open-id=\"" +
          esc(t.id) +
          "\">" +
          "<div class=\"tm-row\"><strong>" +
          sym +
          "</strong> <span class=\"tm-muted\">P&amp;L ~" +
          pct +
          "% · " +
          r +
          "R</span> <span class=\"tm-muted\">@" +
          esc(t.lastPrice != null ? t.lastPrice : "—") +
          "</span></div>" +
          alertCtx +
          g +
          "<div class=\"tm-trade-wrap\" style=\"margin-top:10px;\">" +
          actionHtml +
          "</div>" +
          "<div class=\"tm-exit-row\">" +
          "<label class=\"tm-muted\">Exit</label>" +
          "<input type=\"number\" step=\"0.01\" class=\"tm-exit-price\" data-tm-tid=\"" +
          esc(t.id) +
          "\" placeholder=\"px\" />" +
          "<select class=\"tm-exit-outcome\" data-tm-tid=\"" +
          esc(t.id) +
          "\">" +
          "<option value=\"win\">win</option>" +
          "<option value=\"loss\">loss</option>" +
          "<option value=\"flat\">flat</option>" +
          "</select>" +
          "<button type=\"button\" class=\"tm-btn-exit\" data-tm-exit=\"" +
          esc(t.id) +
          "\">MARK EXITED</button>" +
          "</div></div>"
        );
      })
      .join("");

    host.querySelectorAll(".tm-btn-exit").forEach(function (btn) {
      btn.onclick = function () {
        var tid = btn.getAttribute("data-tm-exit");
        var card = btn.closest(".tm-open-card");
        var inp = card
          ? card.querySelector(".tm-exit-price[data-tm-tid=\"" + tid + "\"]")
          : null;
        var sel = card
          ? card.querySelector(".tm-exit-outcome[data-tm-tid=\"" + tid + "\"]")
          : null;
        var px = inp && inp.value ? parseFloat(inp.value) : NaN;
        if (!Number.isFinite(px)) {
          alert("Enter a valid exit price.");
          return;
        }
        var outcome = sel ? sel.value : "flat";
        fetch(LOG_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "exited",
            tradeId: tid,
            exitPrice: px,
            outcome: outcome,
          }),
          cache: "no-store",
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j2) {
            if (!j2.success) throw new Error(j2.error || "exit failed");
            renderOpenTrades(j2.openTrades || []);
          })
          .catch(function (e) {
            alert(String(e.message || e));
          });
      };
    });
  }

  function fetchOpenTrades() {
    fetch(LOG_URL, { method: "GET", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        setOpenStatus("OPEN OK", true);
        renderOpenTrades(j.openTrades || []);
      })
      .catch(function () {
        setOpenStatus("OPEN ERR", false);
      });
  }

  function applyScanPayload(j, res) {
    if (j && j.alerts) window.__sohelLastAlerts = j.alerts;
    setPanelStatus(res && res.ok ? "SCAN OK" : "SCAN HTTP", !!(res && res.ok));
    if (res && res.ok && j && j.success !== false) {
      window.__sohelLastScanOkAt = Date.now();
    }
    updateRiskPillFromScan(j);
    renderHudStats(j);
    updateRegimeBadgeFromScan(j);
    renderHomeFromScan(j);
    updateHudScanLast();
    fetchHudAlertTracker();
    fetchPositionTracker();
    fetch("/api/health", { cache: "no-store" })
      .then(function (r) {
        return r.json();
      })
      .then(function (h) {
        window.__sohelLastHealthJson = h;
        renderCheckpointStrip(
          (h && h.jobHealth) || {},
          window.__sohelPremarketAsOf,
          window.__sohelLastScanOkAt
        );
      })
      .catch(function () {});
  }

  function pullScan() {
    setPanelStatus("SCAN …", true);
    fetch(SCAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cheap" }),
      cache: "no-store",
    })
      .then(function (r) {
        return r.json().then(function (j) {
          return { r: r, j: j };
        });
      })
      .then(function (o) {
        applyScanPayload(o.j, o.r);
      })
      .catch(function (e) {
        setPanelStatus("SCAN ERR", false);
        var host = document.getElementById("hud-alert-log");
        if (host)
          host.innerHTML =
            '<p class="hint">' + esc(e.message || String(e)) + "</p>";
      });
  }

  function minutesEt(d) {
    var parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "numeric",
      hour12: false,
    }).formatToParts(d);
    var h = 0;
    var m = 0;
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === "hour") h = parseInt(parts[i].value, 10);
      if (parts[i].type === "minute") m = parseInt(parts[i].value, 10);
    }
    return h * 60 + m;
  }

  function weekdayEt(d) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
    }).format(d);
  }

  function nextExpensiveLabel() {
    var d = new Date();
    var w = weekdayEt(d);
    if (w === "Sat" || w === "Sun") return "Next expensive: Mon 8:15 ET";
    var now = minutesEt(d);
    var slots = EXPENSIVE_SLOTS_ET_MIN;
    for (var i = 0; i < slots.length; i++) {
      if (now < slots[i]) {
        var hm = slots[i];
        var hh = Math.floor(hm / 60);
        var mm = hm % 60;
        return (
          "Next expensive ~" +
          (slots[i] - now) +
          "m (" +
          hh +
          ":" +
          (mm < 10 ? "0" : "") +
          mm +
          " ET)"
        );
      }
    }
    return "Next expensive: tomorrow";
  }

  function requestNotifPermission() {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") {
        Notification.requestPermission().catch(function () {});
      }
    } catch (e) {}
  }

  function onScanNotifyAndRefreshOpen(j) {
    if (!j || !j.alerts) return;
    var maxS = 0;
    var volMax = 0;
    j.alerts.forEach(function (a) {
      if (a.score > maxS) maxS = a.score;
      var vr = Number(
        a.details && a.details.volRatio != null ? a.details.volRatio : a.volRatio || 0
      );
      if (vr > volMax) volMax = vr;
    });
    var wild =
      maxS >= 85 ||
      volMax >= 3 ||
      /catalyst|earnings|fda|news|gap|upgrade|breaking/i.test(JSON.stringify(j.alerts));
    if (window.__sohelP7SkipFirstScanNotify == null) {
      window.__sohelP7SkipFirstScanNotify = false;
      window.__sohelLastScanPeak = maxS;
      fetchOpenTrades();
      return;
    }
    var prev = window.__sohelLastScanPeak || 0;
    window.__sohelLastScanPeak = maxS;
    if (
      wild &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      maxS > prev
    ) {
      try {
        new Notification("SOHELATOR — alert spike", {
          body: "Score up to " + Math.round(maxS) + " — check LIVE / HISTORY",
          tag: "sohel-p7-wild",
        });
      } catch (e) {}
    }
    fetchOpenTrades();
  }

  window.__sohelPageLoadAt = Date.now();
  window.__sohelLastScanOkAt = null;
  window.__sohelLastGrokHealth = "skipped";

  function nextMonitorMinutes() {
    var mod = Math.floor(Date.now() / 60000) % 5;
    return mod === 0 ? 5 : 5 - mod;
  }

  function grokLabel(h) {
    if (h === "ok") return "OK";
    if (h === "fallback_cheap") return "OK (fallback)";
    if (h === "error") return "ERROR";
    if (h === "outside_window") return "WINDOW";
    return "—";
  }

  function updateHealthBanner() {
    var hb = document.getElementById("health-banner");
    if (!hb) return;
    var now = Date.now();
    var okAt = window.__sohelLastScanOkAt;
    var stale =
      okAt == null
        ? now - window.__sohelPageLoadAt > 600000
        : now - okAt > 600000;
    hb.classList.toggle("sohel-health--stale", stale);
    var grok = grokLabel(window.__sohelLastGrokHealth);
    var parts = [];
    parts.push(scanStatusLabel);
    parts.push(openStatusLabel);
    parts.push("Poll ~" + nextMonitorMinutes() + "m");
    parts.push("Grok " + grok);
    if (window.__sohelLastScanStatus === "outside_window") {
      parts.push("cheap outside 8–4 ET");
    }
    if (window.__sohelLastScanStatus === "after_hours") {
      parts.push("options session closed");
    }
    parts.push(nextExpensiveLabel());
    parts.push("Self-tuned nightly");
    if (stale) parts.push("Scanner idle 10+ min");
    hb.textContent = parts.join(" · ");
    var errGrok = grok === "ERROR";
    var bad = errGrok || !scanStatusOk || !openStatusOk;
    hb.style.color = bad ? (errGrok ? "#f87171" : "#fbbf24") : "#bef264";
  }

  function onHealthScan(res, j) {
    if (res.ok && j && j.success !== false) {
      window.__sohelLastScanOkAt = Date.now();
    }
    window.__sohelLastScanStatus = j && j.status;
    if (j && j.meta && j.meta.grokHealth != null) {
      window.__sohelLastGrokHealth = j.meta.grokHealth;
    }
    updateHealthBanner();
  }

  var prevAlertSig = null;
  var prevRegSig = null;
  var prevMaxScore = null;
  var prevTradeSnap = {};

  function digestAlerts(alerts) {
    if (!Array.isArray(alerts)) return "";
    return alerts
      .map(function (a) {
        return String(a.symbol || "") + ":" + String(Math.round(Number(a.score) || 0));
      })
      .join("|");
  }

  function digestRegime(j) {
    if (!j || j.success === false) return "";
    var m = j.meta || {};
    var b = m.backtest7d || {};
    return [
      j.status || "",
      j.mode || "",
      m.grokHealth || "",
      b.ev != null ? String(b.ev) : "",
      b.winRate != null ? String(b.winRate) : "",
      Array.isArray(j.alerts) ? j.alerts.length : 0,
    ].join(";");
  }

  function flashAlertCards() {
    var host = document.getElementById("hud-alert-log");
    if (!host) return;
    host.querySelectorAll(".hud-log-row").forEach(function (el) {
      el.classList.remove("neon-flash");
      void el.offsetWidth;
      el.classList.add("neon-flash");
      setTimeout(function () {
        el.classList.remove("neon-flash");
      }, 800);
    });
  }

  function regimeFlash() {
    var h = document.getElementById("sohel-regime-header");
    if (!h) return;
    h.classList.remove("regime-flash");
    void h.offsetWidth;
    h.classList.add("regime-flash");
    setTimeout(function () {
      h.classList.remove("regime-flash");
    }, 900);
  }

  function onNeonScan(j) {
    if (!j || j.success === false) return;
    var alerts = j.alerts || [];
    var sig = digestAlerts(alerts);
    var regSig = digestRegime(j);
    var maxScore = alerts.reduce(function (m, a) {
      return Math.max(m, Number(a.score) || 0);
    }, 0);
    if (prevAlertSig !== null && sig !== prevAlertSig) {
      setTimeout(flashAlertCards, 120);
    }
    if (prevRegSig !== null) {
      if (regSig !== prevRegSig) regimeFlash();
      else if (prevMaxScore !== null && maxScore > 85 && prevMaxScore <= 85) {
        regimeFlash();
      }
    }
    prevAlertSig = sig;
    prevRegSig = regSig;
    prevMaxScore = maxScore;
  }

  function pulseOpenTradeCard(tradeId) {
    var id = String(tradeId || "").replace(/"/g, "");
    if (!id) return;
    var el = document.querySelector(
      '#hud-logged-trades .tm-open-card[data-tm-open-id="' + id + '"]'
    );
    if (!el) return;
    el.classList.remove("neon-amber-pulse");
    void el.offsetWidth;
    el.classList.add("neon-amber-pulse");
    setTimeout(function () {
      el.classList.remove("neon-amber-pulse");
    }, 700);
  }

  function onLogTradeJson(j) {
    if (!j || !Array.isArray(j.openTrades)) return;
    j.openTrades.forEach(function (t) {
      var id = t.id;
      if (!id) return;
      var p = Number(t.livePnlPct) || 0;
      var r = Number(t.livePnlR) || 0;
      var ap = Math.abs(p);
      var ar = Math.abs(r);
      var prev = prevTradeSnap[id];
      prevTradeSnap[id] = { p: p, r: r };
      var bigLevel = ap >= 2.5 || ar >= 0.4;
      var moved =
        prev &&
        (Math.abs(p - prev.p) >= 0.45 || Math.abs(r - prev.r) >= 0.12);
      if (bigLevel && (moved || !prev)) {
        requestAnimationFrame(function () {
          pulseOpenTradeCard(id);
        });
      }
    });
  }

  var nativeFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    return nativeFetch(input, init).then(function (res) {
      try {
        var u =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : "";
        if (u.indexOf(SCAN_HOOK) !== -1 && res && res.clone) {
          res
            .clone()
            .json()
            .then(function (j) {
              onHealthScan(res, j);
              onScanNotifyAndRefreshOpen(j);
              onNeonScan(j);
            })
            .catch(function () {});
        }
        if (u.indexOf(LOG_URL) !== -1 && res.ok && res.clone) {
          res
            .clone()
            .json()
            .then(onLogTradeJson)
            .catch(function () {});
        }
      } catch (e) {}
      return res;
    });
  };

  function start() {
    showHudPage("home");
    refreshHeaderQuotes();
    tickHudClock();
    if (hudClockTimer) clearInterval(hudClockTimer);
    hudClockTimer = setInterval(tickHudClock, 1000);
    fetchHudAuxiliary();
    fetchPositionTracker();
    fetchHudAlertTracker();
    if (positionTtiTimer) clearInterval(positionTtiTimer);
    positionTtiTimer = setInterval(updateAllPositionTimeInTrade, 60000);
    setInterval(fetchPositionTracker, 60000);
    setInterval(fetchHudAlertTracker, 120000);
    setInterval(fetchHudAuxiliary, 900000);

    var pageHome = document.getElementById("page-hud-home");
    if (pageHome) {
      pageHome.addEventListener("click", function (e) {
        var ent = e.target.closest("[data-sohel-enter]");
        if (ent) {
          var raw = ent.getAttribute("data-sohel-enter") || "";
          var idxColon = raw.indexOf(":");
          var bucket = idxColon >= 0 ? raw.slice(0, idxColon) : "";
          var i = idxColon >= 0 ? parseInt(raw.slice(idxColon + 1), 10) : NaN;
          var list =
            bucket === "tactical"
              ? window.__sohelTacticalList
              : bucket === "firing"
                ? window.__sohelAlignFiring
                : bucket === "heating"
                  ? window.__sohelAlignHeating
                  : null;
          var a = list && !isNaN(i) ? list[i] : null;
          if (!a || !a.symbol) {
            alert("No alert payload — refresh scan.");
            return;
          }
          ent.disabled = true;
          fetch(LOG_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: "entered",
              alert: JSON.parse(JSON.stringify(a)),
            }),
            cache: "no-store",
          })
            .then(function (r) {
              return r.json();
            })
            .then(function (j2) {
              if (!j2.success) throw new Error(j2.error || "log failed");
              ent.textContent = "LOGGED";
              renderOpenTrades(j2.openTrades || []);
            })
            .catch(function (err) {
              ent.disabled = false;
              alert(String(err.message || err));
            });
        }
      });
    }

    var refBtn = document.getElementById("btn-align-refresh");
    if (refBtn) refBtn.addEventListener("click", pullScan);

    pullScan();
    if (pollScanTimer) clearInterval(pollScanTimer);
    pollScanTimer = setInterval(pullScan, POLL_SCAN_MS);

    fetchOpenTrades();
    if (pollOpenTimer) clearInterval(pollOpenTimer);
    pollOpenTimer = setInterval(fetchOpenTrades, POLL_OPEN_MS);

    if (spyLevelsTimer) clearInterval(spyLevelsTimer);
    spyLevelsTimer = setInterval(function () {
      if (document.getElementById("regime-spy-slot")) {
        refreshSpyLevels();
        refreshHeaderQuotes();
      }
    }, 120000);

    requestNotifPermission();
    updateHealthBanner();
    updateHdrLiveFromPanel();
    setInterval(updateHealthBanner, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

/* ─────────────────────────────────────────────────────────────────────────────
   SOHELATOR blueprint — LEARNING tab with AI progress tracking (Prompt 16)
   Unified nav: LIVE (watchlist + regime strip) / HISTORY / LEARNING (3 top + 3 bottom).
   ───────────────────────────────────────────────────────────────────────────── */
(function initSohelLearningPrompt16() {
  var MEMORY_URL = "/api/memory-data";
  var PATTERNS_URL = "/historical_patterns.json";
  var lastLearningFetch = 0;
  var STALE_MS = 90000;

  function p16esc(s) {
    if (s == null || s === "") return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function setUnifiedPage(which) {
    var w =
      which === "live"
        ? "home"
        : which === "history"
          ? "scan"
          : which === "learning"
            ? "brief"
            : which;
    if (typeof window.__sohelShowHudPage === "function") window.__sohelShowHudPage(w);
    if (w === "brief") fetchLearningIfStale(true);
    if (w === "sys" && typeof window.__sohelFetchSysHealth === "function") {
      window.__sohelFetchSysHealth();
    }
  }

  function rebindNavButton(id, which) {
    var el = document.getElementById(id);
    if (!el || !el.parentNode) return;
    var n = el.cloneNode(true);
    el.parentNode.replaceChild(n, el);
    n.addEventListener("click", function () {
      setUnifiedPage(which);
    });
  }

  function rowMetrics(row) {
    var res = Array.isArray(row.results) ? row.results : [];
    var sumEst = res.reduce(function (s, r) {
      return s + (Number(r.estimatedOptionReturn) || 0);
    }, 0);
    var totalR = sumEst / 100;
    var ev = res.length ? sumEst / res.length : null;
    var setups =
      row.snapshotCount != null
        ? row.snapshotCount
        : row.totalCalls != null
          ? row.totalCalls
          : res.length;
    return { totalR: totalR, ev: ev, setups: setups };
  }

  function trendClass(curWr, olderWr) {
    if (olderWr == null || curWr == null || !isFinite(curWr) || !isFinite(olderWr)) {
      return { cls: "learn-trend--flat", sym: "→" };
    }
    if (curWr > olderWr + 0.25) return { cls: "learn-trend--up", sym: "↑" };
    if (curWr < olderWr - 0.25) return { cls: "learn-trend--down", sym: "↓" };
    return { cls: "learn-trend--flat", sym: "→" };
  }

  function renderLearningLatest(imp, reviews, patterns) {
    var host = document.getElementById("learning-latest-body");
    if (!host) return;
    var blocks = [];
    var latest = reviews && reviews.length ? reviews[0] : null;
    if (latest) {
      var aiTxt =
        latest.claudeAnalysis ||
        latest.eodAnalysis ||
        latest.improvementSuggestions ||
        "";
      aiTxt = String(aiTxt).trim();
      if (aiTxt.length > 1400) aiTxt = aiTxt.slice(0, 1400) + "…";
      blocks.push(
        '<div class="learn-block"><div class="learn-k">EOD / AI REVIEW · ' +
          p16esc(latest.date || "—") +
          '</div><div class="learn-ai-box">' +
          (aiTxt ? p16esc(aiTxt) : "<span class=\"hint\">No narrative stored for this day.</span>") +
          "</div></div>"
      );
    }
    if (imp && Array.isArray(imp.suggestions) && imp.suggestions.length) {
      blocks.push(
        '<div class="learn-block"><div class="learn-k">PATTERN IMPROVEMENTS</div><ul class="learn-ul">' +
          imp.suggestions
            .slice(0, 12)
            .map(function (x) {
              return "<li>" + p16esc(typeof x === "string" ? x : x.message || x.text || JSON.stringify(x)) + "</li>";
            })
          .join("") +
          "</ul></div>"
      );
    }
    if (patterns && patterns.length) {
      var notes = patterns
        .slice(-6)
        .map(function (p) {
          return p && p.note ? p.note : null;
        })
        .filter(Boolean);
      if (notes.length) {
        blocks.push(
          '<div class="learn-block"><div class="learn-k">NEW PATTERNS (LOCAL JSON)</div><ul class="learn-ul">' +
            notes.map(function (n) {
              return "<li>" + p16esc(n) + "</li>";
            }).join("") +
            "</ul></div>"
        );
      }
    }
    if (!blocks.length) {
      host.innerHTML =
        '<p class="hint">No nightly blob data yet. Run <code style="color:var(--cyan)">/api/scan-eod</code> on schedule or open this page after EOD reviews populate.</p>';
      return;
    }
    host.innerHTML = blocks.join("");
  }

  function renderLearningTable(reviews) {
    var tb = document.getElementById("learning-progress-tbody");
    if (!tb) return;
    if (!reviews || !reviews.length) {
      tb.innerHTML =
        '<tr><td colspan="6" class="hint">No historical rows — EOD reviews will appear here.</td></tr>';
      return;
    }
    var sorted = reviews.slice().sort(function (a, b) {
      var ta = Number(a.timestamp) || 0;
      var tb_ = Number(b.timestamp) || 0;
      if (tb_ !== ta) return tb_ - ta;
      return String(b.date || "").localeCompare(String(a.date || ""));
    });
    tb.innerHTML = sorted
      .map(function (row, i) {
        var m = rowMetrics(row);
        var wr = row.winRate;
        var wrN = wr != null && isFinite(Number(wr)) ? Number(wr) : null;
        var older = sorted[i + 1];
        var olderWr =
          older && older.winRate != null && isFinite(Number(older.winRate))
            ? Number(older.winRate)
            : null;
        var tr = trendClass(wrN, olderWr);
        var wrStr = wrN != null ? wrN.toFixed(1) + "%" : "—";
        var evStr = m.ev != null && isFinite(m.ev) ? m.ev.toFixed(1) + "%" : "—";
        return (
          "<tr><td>" +
          p16esc(row.date || "—") +
          "</td><td>" +
          p16esc(wrStr) +
          "</td><td>" +
          p16esc(m.totalR.toFixed(2)) +
          "</td><td>" +
          p16esc(evStr) +
          "</td><td>" +
          p16esc(String(m.setups != null ? m.setups : "—")) +
          '</td><td><span class="learn-trend ' +
          tr.cls +
          '" title="vs prior row">' +
          tr.sym +
          "</span></td></tr>"
        );
      })
      .join("");
  }

  function fetchLearningIfStale(force) {
    var now = Date.now();
    if (!force && now - lastLearningFetch < STALE_MS) return;
    lastLearningFetch = now;
    var host = document.getElementById("learning-latest-body");
    if (host) host.innerHTML = '<p class="hint" style="padding:0;">Loading…</p>';

    Promise.all([
      fetch(MEMORY_URL + "?type=improvements", { cache: "no-store" }).then(function (r) {
        return r.json();
      }),
      fetch(MEMORY_URL + "?type=learning-log", { cache: "no-store" }).then(function (r) {
        return r.json();
      }),
      fetch(PATTERNS_URL, { cache: "no-store" }).then(function (r) {
        return r.ok ? r.json() : [];
      }),
    ])
      .then(function (tuple) {
        var imp = tuple[0];
        var logPack = tuple[1] || {};
        var reviews = Array.isArray(logPack.reviews) ? logPack.reviews : [];
        var patterns = Array.isArray(tuple[2]) ? tuple[2] : [];
        renderLearningLatest(imp, reviews, patterns);
        renderLearningTable(reviews);
      })
      .catch(function () {
        if (host)
          host.innerHTML =
            '<p class="hint">Could not load learning APIs (offline or CORS). Showing patterns file only…</p>';
        fetch(PATTERNS_URL, { cache: "no-store" })
          .then(function (r) {
            return r.json();
          })
          .then(function (patterns) {
            renderLearningLatest(null, [], Array.isArray(patterns) ? patterns : []);
            renderLearningTable([]);
          })
          .catch(function () {});
      });
  }

  function wirePrompt16() {
    rebindNavButton("nav-hud-home", "home");
    rebindNavButton("nav-hud-pos", "pos");
    rebindNavButton("nav-hud-scan", "scan");
    rebindNavButton("nav-hud-brief", "brief");
    rebindNavButton("nav-hud-sys", "sys");

    window.sohelSelectMainTab = function (k) {
      if (k === "alerts" || k === "history") setUnifiedPage("scan");
      else if (k === "learning") setUnifiedPage("brief");
      else setUnifiedPage("home");
    };

    var refL = document.getElementById("btn-learning-refresh");
    if (refL)
      refL.addEventListener("click", function () {
        lastLearningFetch = 0;
        fetchLearningIfStale(true);
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", wirePrompt16);
  } else {
    wirePrompt16();
  }
})();

