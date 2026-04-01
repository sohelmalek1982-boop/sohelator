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
 * SOHELATOR blueprint — new Action Panel wiring (Prompt 4)
 * Polls POST /api/scan every 60s (mode: cheap), renders server drivingText (formatDrivingAlert),
 * shows historical comparison per alert, Refresh Now + LIVE status. Does not modify calculateIgnition above.
 */
(function initSohelatorActionPanelPrompt4() {
  var SCAN_URL = "/api/scan";
  var POLL_MS = 60000;
  var pollTimer = null;

  function esc(s) {
    if (s == null || s === "") return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function setPanelStatus(label, ok) {
    var el = document.getElementById("panel-status");
    if (!el) return;
    el.textContent = label;
    el.style.color = ok ? "#bef264" : "#fbbf24";
    el.style.border = ok ? "1px solid rgba(163,230,53,0.35)" : "1px solid rgba(251,191,36,0.4)";
  }

  function renderCards(alerts) {
    var host = document.getElementById("alert-cards");
    if (!host) return;

    if (!alerts || !alerts.length) {
      host.innerHTML =
        '<p class="muted" style="font-size:0.8rem;line-height:1.5;margin:0;">No alerts above min score / EV gates — try Refresh after RTH or check API.</p>';
      return;
    }

    host.innerHTML = alerts
      .map(function (a) {
        var drive = a.drivingText
          ? esc(a.drivingText)
          : "<span class=\"muted\">(no drivingText — server should return formatDrivingAlert string)</span>";
        var hist = a.historicalSummary
          ? "<div class=\"ap-hist\">Historical comparison: " + esc(a.historicalSummary) + "</div>"
          : "";
        return '<div class="ap-drive-card">' + drive + hist + "</div>";
      })
      .join("");
  }

  function fetchScan() {
    if (!document.getElementById("alert-cards")) return;

    setPanelStatus("…", true);
    fetch(SCAN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "cheap" }),
      cache: "no-store",
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        setPanelStatus("LIVE", true);
        if (!j.success) {
          document.getElementById("alert-cards").innerHTML =
            '<p class="muted" style="font-size:0.8rem;">Scanner: ' + esc(j.error || "error") + "</p>";
          return;
        }
        renderCards(j.alerts || []);
      })
      .catch(function (e) {
        setPanelStatus("ERR", false);
        var ac = document.getElementById("alert-cards");
        if (ac)
          ac.innerHTML =
            '<p class="muted" style="font-size:0.8rem;">' + esc(e.message || String(e)) + "</p>";
      });
  }

  function start() {
    var btn = document.getElementById("btn-action-panel-refresh");
    if (btn) {
      btn.addEventListener("click", fetchScan);
    }
    fetchScan();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(fetchScan, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();

/**
 * SOHELATOR blueprint — trade management layer (Prompt 5)
 * Open trades panel, MARK ENTERED on alert cards, live P&L poll (30s), dynamic actions, log via /api/log-trade.
 */
(function initSohelatorTradeManagementPrompt5() {
  var LOG_URL = "/api/log-trade";
  var SCAN_HOOK = "/api/scan";
  var POLL_MS = 30000;
  var pollOpenTimer = null;

  function esc(s) {
    if (s == null || s === "") return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
  }

  function alertFromCardIndex(idx) {
    var list = window.__sohelLastAlerts || [];
    var a = list[idx] ? Object.assign({}, list[idx]) : {};
    var sym = a.symbol || a.ticker;
    if (!sym && a.drivingText) {
      var m = String(a.drivingText).match(/\b([A-Z]{1,5})\b/);
      if (m) sym = m[1];
    }
    if (sym) a.symbol = String(sym).toUpperCase();
    return a;
  }

  function setOpenStatus(label, ok) {
    var el = document.getElementById("open-status");
    if (!el) return;
    el.textContent = label;
    el.style.color = ok ? "#fcd34d" : "#fb923c";
    el.style.border = ok ? "1px solid rgba(251,191,36,0.35)" : "1px solid rgba(251,146,60,0.45)";
  }

  function renderOpenTrades(list) {
    var host = document.getElementById("open-trade-cards");
    if (!host) return;
    if (!list || !list.length) {
      host.innerHTML =
        '<p class="tm-muted" style="margin:0;font-size:0.75rem;">No open trades — mark ENTERED from alerts above.</p>';
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
          g +
          "<div class=\"tm-trade-wrap\" style=\"border-top-color:rgba(251,191,36,0.2);\">" +
          actionHtml +
          "</div>" +
          "<div class=\"tm-exit-row\">" +
          "<label class=\"tm-muted\">Exit</label>" +
          "<input type=\"number\" step=\"0.01\" class=\"tm-exit-price\" data-tm-tid=\"" +
          esc(t.id) +
          "\" placeholder=\"px\" aria-label=\"Exit price\" />" +
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
        var inp = card ? card.querySelector(".tm-exit-price[data-tm-tid=\"" + tid + "\"]") : null;
        var sel = card ? card.querySelector(".tm-exit-outcome[data-tm-tid=\"" + tid + "\"]") : null;
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
          .then(function (j) {
            if (!j.success) throw new Error(j.error || "exit failed");
            renderOpenTrades(j.openTrades || []);
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
        setOpenStatus("LIVE", true);
        renderOpenTrades(j.openTrades || []);
      })
      .catch(function () {
        setOpenStatus("ERR", false);
      });
  }

  function injectTradeControls() {
    var cards = document.querySelectorAll("#alert-cards .ap-drive-card");
    cards.forEach(function (card, idx) {
      if (card.querySelector("[data-tm-injected]")) return;
      var wrap = document.createElement("div");
      wrap.setAttribute("data-tm-injected", "1");
      wrap.className = "tm-trade-wrap";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tm-btn-enter";
      btn.textContent = "MARK ENTERED";
      btn.setAttribute("data-tm-idx", String(idx));
      btn.onclick = function () {
        var payload = alertFromCardIndex(idx);
        if (!payload.symbol) {
          alert("Could not detect symbol — wait for scan or refresh.");
          return;
        }
        btn.disabled = true;
        fetch(LOG_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "entered", alert: payload }),
          cache: "no-store",
        })
          .then(function (r) {
            return r.json();
          })
          .then(function (j) {
            if (!j.success) throw new Error(j.error || "log failed");
            wrap.innerHTML =
              "<span class=\"tm-muted\" style=\"margin:0;\">Entered logged — see OPEN TRADES · " +
              esc(j.trade && j.trade.id ? j.trade.id : "ok") +
              "</span>";
            renderOpenTrades(j.openTrades || []);
          })
          .catch(function (e) {
            btn.disabled = false;
            alert(String(e.message || e));
          });
      };
      wrap.appendChild(btn);
      card.appendChild(wrap);
    });
  }

  var obs = new MutationObserver(function () {
    injectTradeControls();
  });
  var ac = document.getElementById("alert-cards");
  if (ac) {
    obs.observe(ac, { childList: true, subtree: true });
  }

  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    return origFetch.apply(this, arguments).then(function (res) {
      try {
        var u = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (u.indexOf(SCAN_HOOK) !== -1 && res && res.clone) {
          res
            .clone()
            .json()
            .then(function (j) {
              if (j && j.alerts) window.__sohelLastAlerts = j.alerts;
            })
            .catch(function () {});
        }
      } catch (e1) {}
      return res;
    });
  };

  function startTm() {
    injectTradeControls();
    fetchOpenTrades();
    if (pollOpenTimer) clearInterval(pollOpenTimer);
    pollOpenTimer = setInterval(fetchOpenTrades, POLL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startTm);
  } else {
    startTm();
  }
})();

/**
 * SOHELATOR blueprint — Final polish (Prompt 7): notifications, next expensive ET countdown,
 * open-trades refresh on new scan, self-tuned badge. Duplicates open-trade card HTML to refresh after /api/scan without editing Prompt 5.
 */
(function initSohelatorFinalPolishPrompt7() {
  var LOG_URL = "/api/log-trade";
  var SCAN_HOOK = "/api/scan";
  var EXPENSIVE_SLOTS_ET_MIN = [495, 565, 585, 660, 840, 960];

  function esc(s) {
    if (s == null || s === "") return "";
    var d = document.createElement("div");
    d.textContent = String(s);
    return d.innerHTML;
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
    if (w === "Sat" || w === "Sun") {
      return "Next expensive: Mon 8:15 ET";
    }
    var now = minutesEt(d);
    var slots = EXPENSIVE_SLOTS_ET_MIN;
    for (var i = 0; i < slots.length; i++) {
      if (now < slots[i]) {
        var hm = slots[i];
        var hh = Math.floor(hm / 60);
        var mm = hm % 60;
        return "Next expensive scan in ~" + (slots[i] - now) + " min (" + hh + ":" + (mm < 10 ? "0" : "") + mm + " ET)";
      }
    }
    return "Next expensive: tomorrow 8:15 ET";
  }

  function updateFooter() {
    var el = document.getElementById("next-scan-time");
    if (el) el.textContent = nextExpensiveLabel();
    var st = document.getElementById("self-tuned");
    if (st) st.textContent = "System self-tuned";
  }

  function requestNotifPermission() {
    try {
      if (typeof Notification === "undefined") return;
      if (Notification.permission === "default") {
        Notification.requestPermission().catch(function () {});
      }
    } catch (e) {}
  }

  function p7RenderOpenTrades(list) {
    var host = document.getElementById("open-trade-cards");
    if (!host) return;
    if (!list || !list.length) {
      host.innerHTML =
        '<p class="tm-muted" style="margin:0;font-size:0.75rem;">No open trades — mark ENTERED from alerts above.</p>';
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
          g +
          "<div class=\"tm-trade-wrap\" style=\"border-top-color:rgba(251,191,36,0.2);\">" +
          actionHtml +
          "</div>" +
          "<div class=\"tm-exit-row\">" +
          "<label class=\"tm-muted\">Exit</label>" +
          "<input type=\"number\" step=\"0.01\" class=\"tm-exit-price\" data-tm-tid=\"" +
          esc(t.id) +
          "\" placeholder=\"px\" aria-label=\"Exit price\" />" +
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
        var inp = card ? card.querySelector(".tm-exit-price[data-tm-tid=\"" + tid + "\"]") : null;
        var sel = card ? card.querySelector(".tm-exit-outcome[data-tm-tid=\"" + tid + "\"]") : null;
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
          .then(function (j) {
            if (!j.success) throw new Error(j.error || "exit failed");
            p7RenderOpenTrades(j.openTrades || []);
          })
          .catch(function (e) {
            alert(String(e.message || e));
          });
      };
    });
  }

  function p7RefreshOpenTrades() {
    fetch(LOG_URL, { method: "GET", cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (j) {
        p7RenderOpenTrades(j.openTrades || []);
        var os = document.getElementById("open-status");
        if (os) {
          os.textContent = "LIVE";
          os.style.color = "#fcd34d";
        }
      })
      .catch(function () {});
  }

  function onScanPayload(j) {
    if (!j || !j.alerts) return;
    var maxS = 0;
    var volMax = 0;
    j.alerts.forEach(function (a) {
      if (a.score > maxS) maxS = a.score;
      var vr = Number(a.details && a.details.volRatio != null ? a.details.volRatio : a.volRatio || 0);
      if (vr > volMax) volMax = vr;
    });
    var wild =
      maxS >= 85 ||
      volMax >= 3 ||
      /catalyst|earnings|fda|news|gap|upgrade|breaking/i.test(JSON.stringify(j.alerts));
    if (window.__sohelP7SkipFirstScanNotify == null) {
      window.__sohelP7SkipFirstScanNotify = false;
      window.__sohelLastScanPeak = maxS;
      p7RefreshOpenTrades();
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
          body: "Score up to " + Math.round(maxS) + " — review WHAT TO DO NOW",
          tag: "sohel-p7-wild",
        });
      } catch (e) {}
    }
    p7RefreshOpenTrades();
  }

  var prevFetch = window.fetch;
  window.fetch = function (input, init) {
    return prevFetch.apply(this, arguments).then(function (res) {
      try {
        var u = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (u.indexOf(SCAN_HOOK) !== -1 && res && res.clone) {
          res
            .clone()
            .json()
            .then(onScanPayload)
            .catch(function () {});
        }
      } catch (e1) {}
      return res;
    });
  };

  function startP7() {
    requestNotifPermission();
    updateFooter();
    setInterval(updateFooter, 30000);
    var sys = document.getElementById("system-status");
    if (sys) {
      sys.style.borderColor = "rgba(163, 230, 53, 0.4)";
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startP7);
  } else {
    startP7();
  }
})();

/**
 * SOHELATOR blueprint — System health banner + scan stale toast (Prompt 8)
 */
(function initSohelatorHealthPrompt8() {
  var SCAN_HOOK = "/api/scan";
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
    var ht = document.getElementById("health-text");
    if (!ht) return;
    var grok = grokLabel(window.__sohelLastGrokHealth);
    var line =
      "Next scan ~" + nextMonitorMinutes() + " min · Last Grok: " + grok;
    if (window.__sohelLastScanStatus === "outside_window") {
      line += " · ET 8–4: window off (cheap)";
    }
    ht.textContent = line;
    ht.style.color = grok === "ERROR" ? "#f87171" : "#bef264";
  }

  function checkScanStaleToast() {
    var toast = document.getElementById("scan-fail-toast");
    if (!toast) return;
    var now = Date.now();
    var okAt = window.__sohelLastScanOkAt;
    var stale =
      okAt == null
        ? now - window.__sohelPageLoadAt > 600000
        : now - okAt > 600000;
    if (stale) {
      toast.classList.add("is-visible");
    } else {
      toast.classList.remove("is-visible");
    }
  }

  function onScanJson(res, j) {
    if (res.ok && j && j.success !== false) {
      window.__sohelLastScanOkAt = Date.now();
    }
    window.__sohelLastScanStatus = j && j.status;
    if (j && j.meta && j.meta.grokHealth != null) {
      window.__sohelLastGrokHealth = j.meta.grokHealth;
    }
    updateHealthBanner();
    checkScanStaleToast();
  }

  var innerFetch = window.fetch;
  window.fetch = function (input, init) {
    return innerFetch.apply(this, arguments).then(function (res) {
      try {
        var u = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (u.indexOf(SCAN_HOOK) !== -1 && res && res.clone) {
          res
            .clone()
            .json()
            .then(function (j) {
              onScanJson(res, j);
            })
            .catch(function () {});
        }
      } catch (e) {}
      return res;
    });
  };

  function startP8() {
    updateHealthBanner();
    checkScanStaleToast();
    setInterval(function () {
      updateHealthBanner();
      checkScanStaleToast();
    }, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startP8);
  } else {
    startP8();
  }
})();

/**
 * SOHELATOR blueprint — 3-tab layout (Prompt 9): HOME / ALERTS / OPEN TRADES,
 * regime + watchlist on HOME, full alert list newest-first on ALERTS (no dedupe),
 * outer fetch hook refreshes home + defers alert-cards after Prompt 4 render.
 * SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12):
 * HOME watchlist uses meta.universeSymbols (full liquid list) with per-symbol alert overlay; merges universe into broker wl.
 */
(function initSohelatorThreeTabLayoutPrompt9() {
  var SCAN_HOOK = "/api/scan";
  var SPY_LEVELS_SYM = "SPY";
  var spyLevelsTimer = null;

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
    document.querySelectorAll(".sohel-level-cell").forEach(function (cell) {
      cell.classList.remove("sohel-near-level");
    });
  }

  function maybeHighlightLevel(last, levelPx, levelValId) {
    if (!isFinite(last) || !isFinite(levelPx) || !levelValId) return;
    var thr = Math.abs(last * 0.0015);
    if (Math.abs(last - levelPx) > thr) return;
    var el = document.getElementById(levelValId);
    var cell = el && el.closest ? el.closest(".sohel-level-cell") : null;
    if (cell) cell.classList.add("sohel-near-level");
  }

  function refreshSpyLevels() {
    var sym = SPY_LEVELS_SYM;
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
          var setTxt = function (id, t) {
            var el = document.getElementById(id);
            if (el) el.textContent = t;
          };
          clearLevelHighlights();
          setTxt("home-level-price", isFinite(last) ? fmtPx(last) : "—");
          if (piv) {
            setTxt("home-level-pp", fmtPx(piv.pp));
            setTxt("home-level-r1", fmtPx(piv.r1));
            setTxt("home-level-s1", fmtPx(piv.s1));
            if (isFinite(last)) {
              maybeHighlightLevel(last, piv.r1, "home-level-r1");
              maybeHighlightLevel(last, piv.pp, "home-level-pp");
              maybeHighlightLevel(last, piv.s1, "home-level-s1");
            }
          }
          var note = document.getElementById("home-level-note");
          if (note && prev && prev.date) {
            note.textContent =
              "Prior bar " +
              String(prev.date) +
              " H/L/C → classic PP / R1 / S1 vs live " +
              sym +
              " quote.";
          }
        });
      })
      .catch(function () {
        /* optional: SPY quote/history may fail if Tradier proxy idle */
      });
  }

  function selectTab(tabId) {
    var map = { home: "home-page", alerts: "alerts-page", trades: "open-trades-page" };
    document.querySelectorAll("#sohel-tabbar .sohel-tab").forEach(function (btn) {
      var on = btn.getAttribute("data-sohel-tab") === tabId;
      btn.classList.toggle("sohel-tab--active", on);
      btn.setAttribute("aria-selected", on ? "true" : "false");
    });
    Object.keys(map).forEach(function (key) {
      var el = document.getElementById(map[key]);
      if (!el) return;
      var show = key === tabId;
      if (show) {
        el.removeAttribute("hidden");
        el.classList.add("sohel-tab-page--active");
      } else {
        el.setAttribute("hidden", "");
        el.classList.remove("sohel-tab-page--active");
      }
    });
  }

  window.sohelSelectMainTab = selectTab;

  function bindTabBar() {
    var bar = document.getElementById("sohel-tabbar");
    if (!bar) return;
    bar.querySelectorAll(".sohel-tab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-sohel-tab");
        if (id) selectTab(id);
      });
    });
  }

  function renderHomeFromScan(j) {
    var bodyEl = document.getElementById("home-regime-body");
    var pill = document.getElementById("home-regime-pill");
    var wlMeta = document.getElementById("home-watchlist-meta");
    var grid = document.getElementById("home-watchlist-grid");
    if (!bodyEl || !grid) return;

    if (!j || j.success === false) {
      bodyEl.textContent =
        j && j.error
          ? "Scanner: " + String(j.error)
          : "Waiting for scanner…";
      if (pill) pill.textContent = "—";
      if (wlMeta) wlMeta.textContent = "—";
      grid.innerHTML =
        '<p class="muted" style="font-size:0.75rem;margin:0;">No watchlist data.</p>';
      return;
    }

    var meta = j.meta || {};
    var b7 = meta.backtest7d;
    var gh = meta.grokHealth || "—";
    var st = j.status || "ok";
    if (pill) {
      pill.textContent =
        st === "outside_window" ? "OUTSIDE 8–4 ET" : String(j.mode || "cheap").toUpperCase();
    }

    var lines = [];
    lines.push(
      "Scanner mode: " + String(j.mode || "cheap") + (st === "outside_window" ? " (expensive → cheap outside window)" : "")
    );
    lines.push("Live alerts this pass: " + (Array.isArray(j.alerts) ? j.alerts.length : 0));
    if (b7) {
      lines.push(
        "7d backtest sample — EV " +
          (b7.ev != null ? Number(b7.ev).toFixed(3) : "—") +
          ", WR " +
          (b7.winRate != null ? Math.round(b7.winRate * 100) / 100 : "—") +
          ", setups " +
          (b7.totalSetups != null ? b7.totalSetups : "—")
      );
    }
    lines.push("Grok health: " + gh);
    if (meta.minScore != null) lines.push("Min score gate: " + meta.minScore);

    var metricsHtml = "";
    if (b7) {
      metricsHtml =
        '<div class="sohel-regime-metrics">' +
        '<div class="sohel-regime-metric"><div class="lab">7d EV</div><div class="val">' +
        esc(b7.ev != null ? Number(b7.ev).toFixed(2) : "—") +
        '</div></div><div class="sohel-regime-metric"><div class="lab">Win %</div><div class="val">' +
        esc(b7.winRate != null ? Math.round(b7.winRate * 100) + "%" : "—") +
        '</div></div><div class="sohel-regime-metric"><div class="lab">Setups</div><div class="val">' +
        esc(b7.totalSetups != null ? String(b7.totalSetups) : "—") +
        "</div></div></div>";
    }

    bodyEl.innerHTML =
      "<p class=\"sohel-regime-lede\" style=\"margin:0 0 12px;font-size:0.78rem;line-height:1.55;color:rgba(238,248,255,0.88);\">" +
      lines.map(function (L) {
        return esc(L);
      }).join("<br/>") +
      "</p>" +
      metricsHtml;

    var uni =
      Array.isArray(meta.universeSymbols) && meta.universeSymbols.length
        ? meta.universeSymbols
        : null;

    if (wlMeta) {
      wlMeta.textContent =
        (uni ? uni.length : Array.isArray(j.alerts) ? j.alerts.length : 0) +
        " liquid names · tap ALERTS for full cards";
    }

    if (
      typeof window.sohelMergeUniverseIntoWl === "function" &&
      uni &&
      uni.length
    ) {
      try {
        window.sohelMergeUniverseIntoWl(uni);
      } catch (e1) {
        console.warn("Prompt12 merge wl", e1);
      }
    }

    var alerts = Array.isArray(j.alerts) ? j.alerts : [];
    var bySym = {};
    alerts.forEach(function (a) {
      var k = String(a.symbol || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.-]/g, "")
        .slice(0, 8);
      if (!k) return;
      if (
        !bySym[k] ||
        (Number(a.score) || 0) > (Number(bySym[k].score) || 0)
      ) {
        bySym[k] = a;
      }
    });

    function tileHtml(symU, a) {
      var sym = esc(symU || "—");
      var rawSym = String(symU || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.-]/g, "")
        .slice(0, 8);
      var sc = a && a.score != null ? Math.round(Number(a.score)) : "—";
      var play = a ? esc(a.playTypeLabel || a.playType || "—") : "—";
      var dir = a ? esc(a.direction || "—") : "—";
      var txt = String(a && (a.aiVerdict || a.drivingText || "") ? a.aiVerdict || a.drivingText : "");
      var cat = /HIGH-PROBABILITY CATALYST PLAY/i.test(txt);
      var badge = cat
        ? '<div class="sohel-wl-cat font-mono">CATALYST</div>'
        : "";
      var scoreLine = a ? "SCORE " + esc(String(sc)) : "NO SETUP";
      return (
        '<div class="sohel-wl-tile" data-symbol="' +
        rawSym +
        '"><div><span class="sohel-wl-sym">' +
        sym +
        "</span>" +
        badge +
        '<div class="sohel-wl-meta">' +
        play +
        " · " +
        dir +
        '</div></div><div class="sohel-wl-score">' +
        scoreLine +
        "</div></div>"
      );
    }

    if (uni && uni.length) {
      var sortedU = uni.slice().sort(function (a, b) {
        var ra = String(a || "")
          .toUpperCase()
          .replace(/[^A-Z0-9.-]/g, "")
          .slice(0, 8);
        var rb = String(b || "")
          .toUpperCase()
          .replace(/[^A-Z0-9.-]/g, "")
          .slice(0, 8);
        var A = bySym[ra];
        var B = bySym[rb];
        var sa = A ? Number(A.score) || 0 : -1;
        var sb = B ? Number(B.score) || 0 : -1;
        if (sb !== sa) return sb - sa;
        return String(a).localeCompare(String(b));
      });
      grid.innerHTML = sortedU.map(function (s) {
        var key = String(s || "")
          .toUpperCase()
          .replace(/[^A-Z0-9.-]/g, "")
          .slice(0, 8);
        return tileHtml(s, bySym[key]);
      }).join("");
      return;
    }

    if (!alerts.length) {
      grid.innerHTML =
        '<p class="muted" style="font-size:0.75rem;margin:0;">No setups passed gates — refresh after RTH.</p>';
      return;
    }

    var sorted = alerts.slice().sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });
    grid.innerHTML = sorted
      .map(function (a) {
        return tileHtml(a.symbol, a);
      })
      .join("");
  }

  function refillAlertsNewestFirst(j) {
    var host = document.getElementById("alert-cards");
    if (!host || !j || j.success === false) return;

    var alerts = Array.isArray(j.alerts) ? j.alerts : [];
    if (!alerts.length) {
      host.innerHTML =
        '<p class="muted" style="font-size:0.8rem;line-height:1.5;margin:0;">No alerts above min score / EV gates — try Refresh after RTH or check API.</p>';
      return;
    }

    var order = alerts.slice().sort(function (a, b) {
      var ta =
        Date.parse(a.ts || a.timestamp || a.createdAt || a.alertAt || "") || 0;
      var tb =
        Date.parse(b.ts || b.timestamp || b.createdAt || b.alertAt || "") || 0;
      if (tb !== ta) return tb - ta;
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });

    host.innerHTML = order
      .map(function (a) {
        var drive = a.drivingText
          ? esc(a.drivingText)
          : "<span class=\"muted\">(no drivingText)</span>";
        var hist = a.historicalSummary
          ? "<div class=\"ap-hist\">Historical comparison: " + esc(a.historicalSummary) + "</div>"
          : "";
        return '<div class="ap-drive-card">' + drive + hist + "</div>";
      })
      .join("");
  }

  function onScanJsonForTabs(res, j) {
    try {
      renderHomeFromScan(j);
      refreshSpyLevels();
      setTimeout(function () {
        refillAlertsNewestFirst(j);
      }, 0);
    } catch (e) {
      console.warn("Prompt9 scan UI", e);
    }
  }

  var innerFetchP9 = window.fetch;
  window.fetch = function (input, init) {
    return innerFetchP9.apply(this, arguments).then(function (res) {
      try {
        var u = typeof input === "string" ? input : input && input.url ? input.url : "";
        if (u.indexOf(SCAN_HOOK) !== -1 && res && res.clone) {
          res
            .clone()
            .json()
            .then(function (j) {
              onScanJsonForTabs(res, j);
            })
            .catch(function () {});
        }
      } catch (e1) {}
      return res;
    });
  };

  function startP9() {
    bindTabBar();
    selectTab("home");
    refreshSpyLevels();
    if (spyLevelsTimer) clearInterval(spyLevelsTimer);
    spyLevelsTimer = setInterval(refreshSpyLevels, 120000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startP9);
  } else {
    startP9();
  }
})();

/**
 * SOHELATOR blueprint — neon motion: alert flash, regime flash, open-trade amber pulse (Prompt 11)
 */
(function initSohelatorNeonMotionPrompt11() {
  var SCAN_HOOK = "/api/scan";
  var LOG_HOOK = "/api/log-trade";

  var prevAlertSig = null;
  var prevRegSig = null;
  var prevMaxScore = null;
  var prevTradeSnap = {};

  function flashAlertCards() {
    var host = document.getElementById("alert-cards");
    if (!host) return;
    host.querySelectorAll(".ap-drive-card").forEach(function (el) {
      el.classList.remove("neon-flash");
    });
    host.querySelectorAll(".ap-drive-card").forEach(function (el) {
      void el.offsetWidth;
      el.classList.add("neon-flash");
      setTimeout(function () {
        el.classList.remove("neon-flash");
      }, 820);
    });
  }

  function regimeFlash() {
    var h = document.getElementById("home-regime-header");
    if (!h) return;
    h.classList.remove("regime-flash");
    void h.offsetWidth;
    h.classList.add("regime-flash");
    setTimeout(function () {
      h.classList.remove("regime-flash");
    }, 900);
  }

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

  function onScanJson(j) {
    if (!j || j.success === false) return;

    var alerts = j.alerts || [];
    var sig = digestAlerts(alerts);
    var regSig = digestRegime(j);
    var maxScore = alerts.reduce(function (m, a) {
      return Math.max(m, Number(a.score) || 0);
    }, 0);

    if (prevAlertSig !== null && sig !== prevAlertSig) {
      setTimeout(function () {
        flashAlertCards();
      }, 120);
    }

    if (prevRegSig !== null) {
      if (regSig !== prevRegSig) {
        regimeFlash();
      } else if (
        prevMaxScore !== null &&
        maxScore > 85 &&
        prevMaxScore <= 85
      ) {
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
      '#open-trade-cards .tm-open-card[data-tm-open-id="' + id + '"]'
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

  var innerFetchNeon = window.fetch;
  window.fetch = function (input, init) {
    return innerFetchNeon.apply(this, arguments).then(function (res) {
      try {
        var u =
          typeof input === "string"
            ? input
            : input && input.url
              ? input.url
              : "";
        if (res && res.clone) {
          if (u.indexOf(SCAN_HOOK) !== -1) {
            res
              .clone()
              .json()
              .then(onScanJson)
              .catch(function () {});
          }
          if (u.indexOf(LOG_HOOK) !== -1 && res.ok) {
            res
              .clone()
              .json()
              .then(onLogTradeJson)
              .catch(function () {});
          }
        }
      } catch (e) {}
      return res;
    });
  };
})();

/* SOHELATOR blueprint — remove NVDA hardcoding + after-hours hourly scans + news/catalyst detection (Prompt 12):
   dynamic HOME watchlist + window.sohelMergeUniverseIntoWl are implemented inside initSohelatorThreeTabLayoutPrompt9. */
