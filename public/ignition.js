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
 * Verbatim 3-tab DOM: #tab-home|alerts|trades, #regime-content, #watchlist-grid,
 * #alerts-list, #open-trades-list, #health-banner
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

  function selectTab(which) {
    var tabs = [
      { btn: "tab-home", page: "home-page", key: "home" },
      { btn: "tab-alerts", page: "alerts-page", key: "alerts" },
      { btn: "tab-trades", page: "trades-page", key: "trades" },
    ];
    tabs.forEach(function (t) {
      var b = document.getElementById(t.btn);
      var p = document.getElementById(t.page);
      var on = t.key === which;
      if (b) b.classList.toggle("active", on);
      if (p) p.classList.toggle("active", on);
    });
  }

  window.sohelSelectMainTab = function (k) {
    selectTab(k);
  };

  function bindTabs() {
    [["tab-home", "home"], ["tab-alerts", "alerts"], ["tab-trades", "trades"]].forEach(
      function (pair) {
        var el = document.getElementById(pair[0]);
        if (el)
          el.addEventListener("click", function () {
            selectTab(pair[1]);
          });
      }
    );
  }

  function grokHtml(j) {
    if (!j || j.success === false || !Array.isArray(j.alerts) || !j.alerts.length) {
      return (
        '<div class="regime-grok"><h3 class="sohel-subh">Grok brief</h3><p class="sohel-grok-body">' +
        esc(
          "Grok co-pilot text appears on expensive scans (ET window) when returned on alerts."
        ) +
        "</p></div>"
      );
    }
    var best = null;
    var bestScore = -1;
    j.alerts.forEach(function (a) {
      var sc = Number(a.score) || 0;
      if (a.aiCoPilot && sc >= bestScore) {
        bestScore = sc;
        best = a;
      }
    });
    if (best && best.aiCoPilot) {
      return (
        '<div class="regime-grok"><h3 class="sohel-subh">Grok brief</h3><div class="sohel-grok-tag">TOP CO-PILOT · ' +
        esc(best.symbol || "—") +
        '</div><div class="sohel-grok-body">' +
        esc(best.aiCoPilot).replace(/\n/g, "<br/>") +
        "</div></div>"
      );
    }
    var any = j.alerts.find(function (a) {
      return a.aiVerdict;
    });
    var txt = any
      ? String(any.aiVerdict)
      : "No Grok body this pass (cheap mode or outside Grok window).";
    return (
      '<div class="regime-grok"><h3 class="sohel-subh">Grok brief</h3><p class="sohel-grok-body">' +
      esc(txt) +
      "</p></div>"
    );
  }

  function renderHomeFromScan(j) {
    var regimeEl = document.getElementById("regime-content");
    var grid = document.getElementById("watchlist-grid");
    if (!regimeEl || !grid) return;

    if (!j || j.success === false) {
      regimeEl.innerHTML =
        '<div id="sohel-regime-header"></div><p class="hint">' +
        esc(j && j.error ? "Scanner: " + String(j.error) : "Waiting for scanner…") +
        "</p>";
      grid.innerHTML = '<p class="hint">No watchlist data.</p>';
      return;
    }

    var meta = j.meta || {};
    var b7 = meta.backtest7d;
    var gh = meta.grokHealth || "—";
    var st = j.status || "ok";
    var pill =
      st === "after_hours"
        ? "AFTER HOURS"
        : st === "outside_window"
          ? "OUTSIDE 8–4 ET"
          : String(j.mode || "cheap").toUpperCase();

    var lines = [];
    lines.push(
      "Mode: " + String(j.mode || "cheap") + (st === "outside_window" ? " (cheap outside window)" : "")
    );
    if (meta.optionsSessionNote) lines.push(String(meta.optionsSessionNote));
    lines.push("Alerts this pass: " + (Array.isArray(j.alerts) ? j.alerts.length : 0));
    if (b7) {
      lines.push(
        "7d EV " +
          (b7.ev != null ? Number(b7.ev).toFixed(3) : "—") +
          " · WR " +
          (b7.winRate != null ? Math.round(b7.winRate * 100) / 100 : "—") +
          " · setups " +
          (b7.totalSetups != null ? b7.totalSetups : "—")
      );
    }
    lines.push("Grok health: " + gh);
    if (meta.minScore != null) lines.push("Min score: " + meta.minScore);

    var metricsHtml = "";
    if (b7) {
      metricsHtml =
        '<div class="sohel-metrics">' +
        '<div class="sohel-metric"><span class="ml">7d EV</span><div class="mv">' +
        esc(b7.ev != null ? Number(b7.ev).toFixed(2) : "—") +
        '</div></div><div class="sohel-metric"><span class="ml">Win %</span><div class="mv">' +
        esc(b7.winRate != null ? Math.round(b7.winRate * 100) + "%" : "—") +
        '</div></div><div class="sohel-metric"><span class="ml">Setups</span><div class="mv">' +
        esc(b7.totalSetups != null ? String(b7.totalSetups) : "—") +
        "</div></div></div>";
    }

    var scanBlock =
      '<div class="regime-scan"><h3 class="sohel-subh">Scanner summary</h3><p class="sohel-grok-body" style="margin-bottom:12px;">' +
      lines.map(function (L) {
        return esc(L);
      }).join("<br/>") +
      "</p>" +
      metricsHtml +
      "</div>";

    regimeEl.innerHTML =
      '<div id="sohel-regime-header" class="sohel-regime-top"><span class="sohel-pill">' +
      esc(pill) +
      '</span></div><div id="regime-spy-slot" class="sohel-spy-slot"><p class="hint">Loading SPY levels…</p></div>' +
      grokHtml(j) +
      scanBlock;

    refreshSpyLevels();

    var uni =
      Array.isArray(meta.universeSymbols) && meta.universeSymbols.length
        ? meta.universeSymbols
        : null;

    var alerts = Array.isArray(j.alerts) ? j.alerts : [];

    if (st === "after_hours") {
      grid.innerHTML =
        '<p class="hint">' +
        esc(
          meta.optionsSessionNote ||
            "Equity options trade 9:30–16:00 ET Mon–Fri — watchlist scan paused."
        ) +
        "</p>";
      return;
    }
    var bySym = {};
    alerts.forEach(function (a) {
      var k = String(a.symbol || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.-]/g, "")
        .slice(0, 8);
      if (!k) return;
      if (!bySym[k] || (Number(a.score) || 0) > (Number(bySym[k].score) || 0)) {
        bySym[k] = a;
      }
    });

    var FIRING_SCORE = 78;
    var HEATING_MIN = 65;

    function formatOptionLineHtml(opt) {
      if (!opt || opt.strike == null || !opt.expiration) return "";
      var r = String(opt.right || "").toLowerCase() === "put" ? "PUT" : "CALL";
      var stk = Number(opt.strike);
      var stks =
        Math.abs(stk - Math.round(stk)) < 1e-6
          ? String(Math.round(stk))
          : stk.toFixed(2);
      var midStr =
        opt.mid != null && isFinite(Number(opt.mid))
          ? " · mid ~$" + Number(opt.mid).toFixed(2)
          : "";
      return (
        esc(r) +
        " $" +
        esc(stks) +
        " · exp " +
        esc(String(opt.expiration)) +
        esc(midStr)
      );
    }

    function cardTierForScore(sc, has) {
      if (!has) return "watch";
      if (sc >= FIRING_SCORE) return "fire";
      if (sc >= HEATING_MIN) return "heat";
      return "watch";
    }

    function radarCardHtml(symU, a, sectionTier) {
      var rawSym = String(symU || "")
        .toUpperCase()
        .replace(/[^A-Z0-9.-]/g, "")
        .slice(0, 8);
      var sym = esc(symU || "—");
      var has = !!a;
      var sc = has && a.score != null ? Math.round(Number(a.score)) : null;
      var tier =
        sectionTier ||
        cardTierForScore(sc != null ? sc : -1, has);
      var last =
        has && a.last != null && isFinite(Number(a.last))
          ? Number(a.last)
          : null;
      var lastStr = last != null ? "$" + last.toFixed(2) : "—";
      var play = has ? String(a.playTypeLabel || a.playType || "").trim() : "";
      var dirRaw = has ? String(a.direction || "").toLowerCase() : "";
      var dirLbl =
        dirRaw === "short" ? "SHORT" : dirRaw === "long" ? "LONG" : "";
      var txt = has
        ? String((a.aiVerdict || "") + (a.drivingText || ""))
        : "";
      var cat = /HIGH-PROBABILITY CATALYST/i.test(txt);
      var badges = [];
      if (tier === "fire" && has) {
        badges.push(
          '<span class="sohel-badge sohel-badge--go">HOT</span>'
        );
      } else if (tier === "heat" && has) {
        badges.push(
          '<span class="sohel-badge sohel-badge--heat">BUILDING</span>'
        );
      }
      if (cat && has) {
        badges.push(
          '<span class="sohel-badge sohel-badge--cat">CATALYST</span>'
        );
      }
      if (play && has) {
        badges.push(
          '<span class="sohel-badge sohel-badge--play">' +
            esc(play.toUpperCase()) +
            "</span>"
        );
      }
      if (dirLbl && has) {
        badges.push(
          '<span class="sohel-badge sohel-badge--dir">' +
            esc(dirLbl) +
            "</span>"
        );
      }
      var optLine = has ? formatOptionLineHtml(a.suggestedOption) : "";
      var optHtml = optLine
        ? '<div class="sohel-radar-opt">' + optLine + "</div>"
        : has
          ? '<div class="sohel-radar-opt sohel-radar-opt--muted">Contract not loaded — refresh scan</div>'
          : '<div class="sohel-radar-opt sohel-radar-opt--muted">No setup this pass</div>';
      var scoreBlock = has
        ? '<div class="sohel-radar-score"><span>' +
          esc(String(sc)) +
          '</span><div class="sohel-radar-bar" style="width:' +
          Math.min(100, Math.max(8, sc)) +
          '%"></div></div>'
        : '<div class="sohel-radar-score sohel-radar-score--na"><span>—</span></div>';
      return (
        '<div class="sohel-radar-card sohel-radar-card--' +
        tier +
        '" data-symbol="' +
        rawSym +
        '"><div class="sohel-radar-accent"></div><div class="sohel-radar-body"><div class="sohel-radar-top"><span class="sohel-radar-sym">' +
        sym +
        '</span><div class="sohel-radar-badges">' +
        badges.join("") +
        "</div>" +
        scoreBlock +
        '</div><div class="sohel-radar-price">' +
        esc(lastStr) +
        "</div>" +
        optHtml +
        "</div></div>"
      );
    }

    function watchlistSection(title, sub, sectionTier, pairs) {
      if (!pairs.length) return "";
      return (
        '<div class="sohel-wl-section sohel-wl-section--' +
        sectionTier +
        '"><div class="sohel-wl-section-head"><span class="sohel-wl-pill">' +
        esc(title) +
        '</span><span class="sohel-wl-sub">' +
        esc(sub) +
        '</span></div><div class="sohel-wl-cards">' +
        pairs
          .map(function (p) {
            return radarCardHtml(p.sym, p.a, sectionTier);
          })
          .join("") +
        "</div></div>"
      );
    }

    function buildPairsFromSymbols(symbols) {
      return symbols.map(function (s) {
        var key = String(s || "")
          .toUpperCase()
          .replace(/[^A-Z0-9.-]/g, "")
          .slice(0, 8);
        return { sym: s, a: bySym[key] || null };
      });
    }

    function sortPairsByScore(pairs) {
      return pairs.slice().sort(function (x, y) {
        var sa = x.a ? Number(x.a.score) || 0 : -1;
        var sb = y.a ? Number(y.a.score) || 0 : -1;
        if (sb !== sa) return sb - sa;
        return String(x.sym).localeCompare(String(y.sym));
      });
    }

    function renderTieredWatchlist(pairs) {
      var fire = [];
      var heat = [];
      var watch = [];
      pairs.forEach(function (p) {
        var a = p.a;
        var sc = a ? Number(a.score) || 0 : -1;
        if (!a) watch.push(p);
        else if (sc >= FIRING_SCORE) fire.push(p);
        else if (sc >= HEATING_MIN) heat.push(p);
        else watch.push(p);
      });
      var html = "";
      html += watchlistSection(
        "FIRING",
        fire.length + " ACTIVE",
        "fire",
        fire
      );
      html += watchlistSection(
        "HEATING",
        heat.length + " BUILDING",
        "heat",
        heat
      );
      html += watchlistSection(
        "WATCH",
        watch.length + " NAMES",
        "watch",
        watch
      );
      grid.innerHTML = html || '<p class="hint">Nothing to show.</p>';
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
      renderTieredWatchlist(sortPairsByScore(buildPairsFromSymbols(sortedU)));
      return;
    }

    if (!alerts.length) {
      grid.innerHTML = '<p class="hint">No setups passed gates.</p>';
      return;
    }

    var sortedA = alerts.slice().sort(function (a, b) {
      return (Number(b.score) || 0) - (Number(a.score) || 0);
    });
    var pairsOnly = sortedA.map(function (a) {
      return { sym: a.symbol, a: a };
    });
    renderTieredWatchlist(pairsOnly);
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

  function alertTimeMs(a) {
    if (a.alertedAt != null && isFinite(Number(a.alertedAt))) {
      return Number(a.alertedAt);
    }
    var iso = Date.parse(a.alertedAtIso || "") || 0;
    if (iso) return iso;
    return (
      Date.parse(a.ts || a.timestamp || a.createdAt || a.alertAt || "") || 0
    );
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
    return esc(r) + " $" + esc(stks) + " · exp " + esc(String(o.expiration)) + esc(mid);
  }

  function alertMetaLineHtml(a) {
    var sym = esc(String(a.symbol || a.ticker || "—").toUpperCase());
    var t = formatAlertTimeEt(a);
    var und =
      a.underlyingAtAlert != null && isFinite(Number(a.underlyingAtAlert))
        ? " · underlying $" + esc(Number(a.underlyingAtAlert).toFixed(2))
        : a.last != null && isFinite(Number(a.last))
          ? " · last $" + esc(Number(a.last).toFixed(2))
          : "";
    var sc =
      a.score != null ? " · score " + esc(String(Math.round(Number(a.score)))) : "";
    var optLn = alertOptionLine(a);
    var optRow = optLn
      ? '<div class="ap-contract">' + optLn + "</div>"
      : "";
    return (
      '<div class="ap-time">' +
      sym +
      " · " +
      esc(t) +
      und +
      sc +
      "</div>" +
      optRow
    );
  }

  function renderAlertsPage(j) {
    var host = document.getElementById("alerts-list");
    if (!host) return;
    if (!j || j.success === false) {
      window.__sohelAlertsDisplayed = [];
      host.innerHTML =
        '<p class="hint">' + esc(j && j.error ? String(j.error) : "No scan yet.") + "</p>";
      return;
    }
    var meta = j.meta || {};
    var alerts = Array.isArray(j.alerts) ? j.alerts : [];
    if (!alerts.length) {
      window.__sohelAlertsDisplayed = [];
      var emptyMsg =
        j.status === "after_hours"
          ? meta.optionsSessionNote ||
            "After hours — no optionable session (9:30–16:00 ET Mon–Fri)."
          : "No alerts this pass.";
      host.innerHTML = '<p class="hint">' + esc(emptyMsg) + "</p>";
      return;
    }
    var order = alerts.slice().sort(function (a, b) {
      var ta = alertTimeMs(a);
      var tb = alertTimeMs(b);
      if (ta !== tb) return ta - tb;
      var sa = String(a.symbol || "").localeCompare(String(b.symbol || ""));
      if (sa !== 0) return sa;
      return (Number(a.score) || 0) - (Number(b.score) || 0);
    });
    window.__sohelAlertsDisplayed = order;
    host.innerHTML = order
      .map(function (a) {
        var metaLn = alertMetaLineHtml(a);
        var drive = a.drivingText
          ? esc(a.drivingText)
          : "<span class=\"tm-muted\">(no drivingText)</span>";
        var hist = a.historicalSummary
          ? "<div class=\"ap-hist\">" + esc(a.historicalSummary) + "</div>"
          : "";
        return '<div class="ap-drive-card">' + metaLn + drive + hist + "</div>";
      })
      .join("");
  }

  function setPanelStatus(label, ok) {
    scanStatusLabel = label;
    scanStatusOk = ok;
    updateHealthBanner();
  }

  function setOpenStatus(label, ok) {
    openStatusLabel = label;
    openStatusOk = ok;
    updateHealthBanner();
  }

  function renderOpenTrades(list) {
    var host = document.getElementById("open-trades-list");
    if (!host) return;
    if (!list || !list.length) {
      host.innerHTML =
        '<p class="tm-muted" style="margin:0;">No open trades — mark ENTERED from ALERTS.</p>';
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

  function alertFromCardIndex(idx) {
    var list = window.__sohelAlertsDisplayed || window.__sohelLastAlerts || [];
    var a = list[idx] ? Object.assign({}, list[idx]) : {};
    var sym = a.symbol || a.ticker;
    if (!sym && a.drivingText) {
      var m = String(a.drivingText).match(/\b([A-Z]{1,5})\b/);
      if (m) sym = m[1];
    }
    if (sym) a.symbol = String(sym).toUpperCase();
    return a;
  }

  function injectTradeControls() {
    var cards = document.querySelectorAll("#alerts-list .ap-drive-card");
    cards.forEach(function (card, idx) {
      if (card.querySelector("[data-tm-injected]")) return;
      var wrap = document.createElement("div");
      wrap.setAttribute("data-tm-injected", "1");
      wrap.className = "tm-trade-wrap";
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tm-btn-enter";
      btn.textContent = "MARK ENTERED";
      btn.onclick = function () {
        var payload = alertFromCardIndex(idx);
        if (!payload.symbol) {
          alert("Could not detect symbol — wait for scan.");
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
          .then(function (j2) {
            if (!j2.success) throw new Error(j2.error || "log failed");
            wrap.innerHTML =
              "<span class=\"tm-muted\">Logged · " +
              esc(j2.trade && j2.trade.id ? j2.trade.id : "ok") +
              "</span>";
            renderOpenTrades(j2.openTrades || []);
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

  var obsAlerts = new MutationObserver(function () {
    injectTradeControls();
  });

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
    renderHomeFromScan(j);
    renderAlertsPage(j);
    setTimeout(injectTradeControls, 0);
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
        var host = document.getElementById("alerts-list");
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
          body: "Score up to " + Math.round(maxS) + " — check ALERTS",
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
    var host = document.getElementById("alerts-list");
    if (!host) return;
    host.querySelectorAll(".ap-drive-card").forEach(function (el) {
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
      '#open-trades-list .tm-open-card[data-tm-open-id="' + id + '"]'
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

  function injectAlertsToolbar() {
    var ap = document.getElementById("alerts-page");
    if (!ap || document.getElementById("sohel-refresh-scan")) return;
    var h2 = ap.querySelector("h2");
    var row = document.createElement("div");
    row.className = "sohel-alerts-toolbar";
    row.style.cssText =
      "display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:14px;";
    row.innerHTML =
      '<button type="button" id="sohel-refresh-scan" class="sohel-tab" style="flex:0 0 auto;min-width:140px;">REFRESH SCAN</button>';
    if (h2 && h2.nextSibling) ap.insertBefore(row, h2.nextSibling);
    else ap.appendChild(row);
    document.getElementById("sohel-refresh-scan").addEventListener("click", pullScan);
  }

  function start() {
    bindTabs();
    selectTab("home");
    injectAlertsToolbar();

    var ac = document.getElementById("alerts-list");
    if (ac) obsAlerts.observe(ac, { childList: true, subtree: true });

    pullScan();
    if (pollScanTimer) clearInterval(pollScanTimer);
    pollScanTimer = setInterval(pullScan, POLL_SCAN_MS);

    fetchOpenTrades();
    if (pollOpenTimer) clearInterval(pollOpenTimer);
    pollOpenTimer = setInterval(fetchOpenTrades, POLL_OPEN_MS);

    if (spyLevelsTimer) clearInterval(spyLevelsTimer);
    spyLevelsTimer = setInterval(function () {
      if (document.getElementById("regime-spy-slot")) refreshSpyLevels();
    }, 120000);

    requestNotifPermission();
    updateHealthBanner();
    setInterval(updateHealthBanner, 15000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
