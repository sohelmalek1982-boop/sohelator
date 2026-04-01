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
 * ALIGN.ICS v3 DOM: #page-live|history, #align-regime-inner, #align-firing-cards,
 * #align-heating-cards, #align-live-list, #history-list, #health-banner
 * SOHELATOR blueprint — full ALIGN.ICS v3 template adoption (Prompt 15)
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
    pill.classList.toggle("align-live-pill--warn", !scanStatusOk);
  }

  function showNavPage(which) {
    var live = document.getElementById("page-live");
    var hist = document.getElementById("page-history");
    var bL = document.getElementById("nav-live");
    var bH = document.getElementById("nav-history");
    var onL = which === "live";
    if (live) live.classList.toggle("active", onL);
    if (hist) hist.classList.toggle("active", !onL);
    if (bL) bL.classList.toggle("active", onL);
    if (bH) bH.classList.toggle("active", !onL);
  }

  window.sohelSelectMainTab = function (k) {
    if (k === "alerts" || k === "history") showNavPage("history");
    else showNavPage("live");
  };

  function bindNav() {
    var l = document.getElementById("nav-live");
    var h = document.getElementById("nav-history");
    if (l)
      l.addEventListener("click", function () {
        showNavPage("live");
      });
    if (h)
      h.addEventListener("click", function () {
        showNavPage("history");
      });
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
    /* SOHELATOR blueprint — full ALIGN.ICS v3 template adoption (Prompt 15): regime + FIRING/HEATING buckets */
    var regimeEl = document.getElementById("align-regime-inner");
    var fireHost = document.getElementById("align-firing-cards");
    var heatHost = document.getElementById("align-heating-cards");
    var fireSub = document.getElementById("firing-sub");
    var heatSub = document.getElementById("heating-sub");
    if (!regimeEl || !fireHost || !heatHost) return;

    var FIRING_MIN = 80;
    var HEATING_MIN = 60;
    var HEATING_MAX = 79;

    function formatExpShort(iso) {
      if (!iso) return "—";
      var d = new Date(iso + "T12:00:00Z");
      if (isNaN(d.getTime())) return esc(String(iso).slice(0, 10));
      return esc(
        new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(d)
      );
    }

    function pctFromTo(from, to) {
      if (
        from == null ||
        to == null ||
        !isFinite(Number(from)) ||
        !isFinite(Number(to)) ||
        Number(from) === 0
      ) {
        return "—";
      }
      var p = ((Number(to) - Number(from)) / Math.abs(Number(from))) * 100;
      return (p >= 0 ? "+" : "") + p.toFixed(1) + "%";
    }

    function watchingSinceLine(a) {
      if (!a || !a.alertedAtIso) return "";
      var ms = Date.parse(a.alertedAtIso);
      if (!ms) return "";
      var s = new Intl.DateTimeFormat("en-US", {
        timeZone: "America/New_York",
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      }).format(new Date(ms));
      return "WATCHING SINCE " + s + " ET";
    }

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

    function levelsGridHtml(a) {
      if (!a) return "";
      var last = a.last;
      var ent = a.entry;
      var st = a.stop;
      var tgt = a.target;
      var eStr =
        ent != null && isFinite(Number(ent)) ? "$" + Number(ent).toFixed(2) : "—";
      var sStr =
        st != null && isFinite(Number(st)) ? "$" + Number(st).toFixed(2) : "—";
      var tStr =
        tgt != null && isFinite(Number(tgt)) ? "$" + Number(tgt).toFixed(2) : "—";
      return (
        '<div class="sohel-levels-grid">' +
        '<div class="sohel-lv"><span class="sohel-lv-lab">ENTRY</span><span class="sohel-lv-val">' +
        esc(eStr) +
        '</span><div class="sohel-lv-sub">' +
        esc(last != null ? pctFromTo(last, ent) + " vs last" : "On signal") +
        '</div></div><div class="sohel-lv sohel-lv--target"><span class="sohel-lv-lab">TARGET</span><span class="sohel-lv-val">' +
        esc(tStr) +
        '</span><div class="sohel-lv-sub">' +
        esc(last != null ? pctFromTo(last, tgt) + " vs last" : "—") +
        '</div></div><div class="sohel-lv sohel-lv--stop"><span class="sohel-lv-lab">STOP</span><span class="sohel-lv-val">' +
        esc(sStr) +
        '</span><div class="sohel-lv-sub">' +
        esc(last != null ? pctFromTo(last, st) + " vs last" : "—") +
        "</div></div></div>"
      );
    }

    function optionPlayBarHtml(a) {
      var o = a && a.suggestedOption;
      if (!o || o.strike == null) return "";
      var letter = String(o.right || "").toLowerCase() === "put" ? "P" : "C";
      var stk = Number(o.strike);
      var play =
        (Math.abs(stk - Math.round(stk)) < 1e-6
          ? String(Math.round(stk))
          : stk.toFixed(2)) + letter;
      var mid =
        o.mid != null && isFinite(Number(o.mid))
          ? "$" + Number(o.mid).toFixed(2)
          : "—";
      var del =
        o.delta != null && isFinite(Number(o.delta))
          ? Number(o.delta).toFixed(2)
          : "—";
      return (
        '<div class="sohel-opt-playbar">' +
        '<div class="sohel-opt-cell"><span class="sohel-opt-lab">PLAY</span><span class="sohel-opt-val">' +
        esc(play) +
        '</span></div><div class="sohel-opt-cell"><span class="sohel-opt-lab">PRICE</span><span class="sohel-opt-val">' +
        esc(mid) +
        '</span></div><div class="sohel-opt-cell"><span class="sohel-opt-lab">EXP</span><span class="sohel-opt-val">' +
        formatExpShort(o.expiration) +
        '</span></div><div class="sohel-opt-cell"><span class="sohel-opt-lab">DELTA</span><span class="sohel-opt-val">' +
        esc(del) +
        "</span></div></div>"
      );
    }

    function priceChgRowHtml(a) {
      if (!a) return "";
      var last =
        a.last != null && isFinite(Number(a.last)) ? Number(a.last) : null;
      var lastStr = last != null ? "$" + last.toFixed(2) : "—";
      var bp = a.barChgPct;
      var chgCls = "align-chg-flat";
      var chgTxt = "—";
      if (bp != null && isFinite(Number(bp))) {
        var p = Number(bp);
        chgCls =
          p > 0.02 ? "align-chg-up" : p < -0.02 ? "align-chg-down" : "align-chg-flat";
        var absD = last && isFinite(last) ? (Math.abs(p) / 100) * last : 0;
        chgTxt =
          (p >= 0 ? "+" : "") +
          p.toFixed(2) +
          "%" +
          (absD > 0 ? " (~$" + absD.toFixed(2) + ")" : "");
      }
      return (
        '<div class="align-price-row"><span class="align-price">' +
        esc(lastStr) +
        '</span><span class="align-chg ' +
        chgCls +
        '">' +
        esc(chgTxt) +
        "</span></div>"
      );
    }

    function alignSetupCardHtml(a, bucket, idx) {
      var tier = bucket === "firing" ? "fire" : "heat";
      var sym = esc(String(a.symbol || "—").toUpperCase());
      var sc = a.score != null ? Math.round(Number(a.score)) : 0;
      var meta = watchingSinceLine(a);
      var goTags =
        bucket === "firing"
          ? '<span class="align-tag align-tag--go">GO GO GO</span>'
          : '<span class="align-tag align-tag--heat">HEATING</span>';
      var setupTag = '<span class="align-tag align-tag--setup">SETTING UP</span>';
      var txt = String((a.aiVerdict || "") + (a.drivingText || ""));
      if (/HIGH-PROBABILITY CATALYST/i.test(txt)) {
        setupTag +=
          '<span class="align-tag align-tag--go" style="border-color:var(--amber);color:var(--amber)">CATALYST</span>';
      }
      var opt = optionPlayBarHtml(a);
      if (!opt) {
        opt =
          '<div class="sohel-opt-playbar"><div class="sohel-opt-cell" style="grid-column:1/-1"><span class="sohel-opt-lab">OPTION</span><span class="sohel-opt-val" style="color:var(--muted);font-size:0.65rem">Chain n/a — refresh</span></div></div>';
      }
      return (
        '<div class="align-card align-card--' +
        tier +
        '"><div class="align-card-ac"></div><div class="align-card-body"><div class="align-card-head"><div><div class="align-sym">' +
        sym +
        '</div>' +
        (meta ? '<div class="align-meta">' + esc(meta) + "</div>" : "") +
        '</div><div class="align-tags">' +
        goTags +
        setupTag +
        "</div></div>" +
        priceChgRowHtml(a) +
        '<div class="align-prog"><i style="width:' +
        Math.min(100, Math.max(4, sc)) +
        '%"></i></div>' +
        indTagsHtml(a) +
        levelsGridHtml(a) +
        opt +
        '<div class="align-actions">' +
        '<button type="button" class="align-btn-enter" data-sohel-enter="' +
        bucket +
        ":" +
        idx +
        '">ENTER NOW</button>' +
        '<button type="button" class="align-btn-wait" data-sohel-wait="1">WAIT RETEST</button>' +
        '<button type="button" class="align-btn-skip">SKIP</button>' +
        "</div></div></div>"
      );
    }

    if (!j || j.success === false) {
      regimeEl.innerHTML =
        '<div id="sohel-regime-header"></div><p class="hint">' +
        esc(j && j.error ? "Scanner: " + String(j.error) : "Waiting for scanner…") +
        "</p>";
      fireHost.innerHTML = "";
      heatHost.innerHTML = "";
      if (fireSub) fireSub.textContent = "0 ACTIVE";
      if (heatSub) heatSub.textContent = "0 BUILDING";
      window.__sohelAlignFiring = [];
      window.__sohelAlignHeating = [];
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
      fireHost.innerHTML =
        '<p class="hint">' +
        esc(
          meta.optionsSessionNote ||
            "Options session closed — 9:30–16:00 ET Mon–Fri."
        ) +
        "</p>";
      heatHost.innerHTML = "";
      if (fireSub) fireSub.textContent = "0 ACTIVE";
      if (heatSub) heatSub.textContent = "0 BUILDING";
      window.__sohelAlignFiring = [];
      window.__sohelAlignHeating = [];
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

    if (fireSub) fireSub.textContent = firing.length + " ACTIVE";
    if (heatSub) heatSub.textContent = heating.length + " BUILDING";

    fireHost.innerHTML = firing.length
      ? firing
          .map(function (a, i) {
            return alignSetupCardHtml(a, "firing", i);
          })
          .join("")
      : '<p class="hint">No FIRING setups (score &lt; ' + FIRING_MIN + ").</p>";

    heatHost.innerHTML = heating.length
      ? heating
          .map(function (a, i) {
            return alignSetupCardHtml(a, "heating", i);
          })
          .join("")
      : '<p class="hint">No HEATING setups (need ' +
        HEATING_MIN +
        "–" +
        HEATING_MAX +
        ").</p>";
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
    var host = document.getElementById("history-list");
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
    /* SOHELATOR blueprint — ALL alerts to Telegram (user wants to review everything) (Prompt 19): prominent timestamp on HISTORY / alerts list */
    host.innerHTML = order
      .map(function (a) {
        var ts = formatAlertTimeEt(a);
        var tsLine =
          '<div class="ap-alert-ts" style="font-family:Space Mono,monospace;font-size:0.8rem;font-weight:700;color:#00f0ff;letter-spacing:0.04em;margin-bottom:10px;text-shadow:0 0 12px rgba(0,240,255,0.25);">ALERT · ' +
          esc(ts) +
          "</div>";
        var metaLn = alertMetaLineHtml(a);
        var drive = a.drivingText
          ? esc(a.drivingText)
          : "<span class=\"tm-muted\">(no drivingText)</span>";
        var hist = a.historicalSummary
          ? "<div class=\"ap-hist\">" + esc(a.historicalSummary) + "</div>"
          : "";
        return '<div class="ap-drive-card">' + tsLine + metaLn + drive + hist + "</div>";
      })
      .join("");
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
    var host = document.getElementById("align-live-list");
    var sub = document.getElementById("live-sub");
    if (!host) return;
    if (sub) sub.textContent = (list && list.length ? list.length : 0) + " OPEN";
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
    updateRiskPillFromScan(j);
    renderHomeFromScan(j);
    renderAlertsPage(j);
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
        var host = document.getElementById("history-list");
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
    var host = document.getElementById("history-list");
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
      '#align-live-list .tm-open-card[data-tm-open-id="' + id + '"]'
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
    /* SOHELATOR blueprint — full ALIGN.ICS v3 template adoption (Prompt 15) */
    bindNav();
    showNavPage("live");
    refreshHeaderQuotes();

    var pageLive = document.getElementById("page-live");
    if (pageLive) {
      pageLive.addEventListener("click", function (e) {
        var ent = e.target.closest("[data-sohel-enter]");
        if (ent) {
          var raw = ent.getAttribute("data-sohel-enter") || "";
          var idxColon = raw.indexOf(":");
          var bucket = idxColon >= 0 ? raw.slice(0, idxColon) : "";
          var i = idxColon >= 0 ? parseInt(raw.slice(idxColon + 1), 10) : NaN;
          var list =
            bucket === "firing"
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

  function setPageVisibility(which) {
    var live = document.getElementById("page-live");
    var hist = document.getElementById("page-history");
    var learn = document.getElementById("learning-page");
    var onL = which === "live";
    var onH = which === "history";
    var onG = which === "learning";
    if (live) live.classList.toggle("active", onL);
    if (hist) hist.classList.toggle("active", onH);
    if (learn) learn.classList.toggle("active", onG);
  }

  function syncTabUi(which) {
    document.querySelectorAll(".align-top-tab").forEach(function (b) {
      var t = b.getAttribute("data-sohel-top-tab");
      b.classList.toggle("active", t === which);
    });
    var mapBottom = { live: "nav-live", history: "nav-history", learning: "nav-learning" };
    ["nav-live", "nav-history", "nav-learning"].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.classList.remove("active");
    });
    var bid = mapBottom[which];
    var nb = bid ? document.getElementById(bid) : null;
    if (nb) nb.classList.add("active");
  }

  function setUnifiedPage(which) {
    setPageVisibility(which);
    syncTabUi(which);
    if (which === "learning") fetchLearningIfStale(true);
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
    rebindNavButton("nav-live", "live");
    rebindNavButton("nav-history", "history");
    rebindNavButton("nav-learning", "learning");

    document.querySelectorAll("[data-sohel-top-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var w = btn.getAttribute("data-sohel-top-tab");
        if (w) setUnifiedPage(w);
      });
    });

    window.sohelSelectMainTab = function (k) {
      if (k === "alerts" || k === "history") setUnifiedPage("history");
      else if (k === "learning") setUnifiedPage("learning");
      else setUnifiedPage("live");
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

