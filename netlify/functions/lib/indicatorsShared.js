function calcRSI(closes, p = 14) {
  if (closes.length < p + 1) return 50;
  const sl = closes.slice(-p - 1);
  let g = 0;
  let l = 0;
  for (let i = 1; i < sl.length; i++) {
    const d = sl[i] - sl[i - 1];
    if (d > 0) g += d;
    else l -= d;
  }
  const ag = g / p;
  const al = l / p;
  return al === 0 ? 100 : 100 - 100 / (1 + ag / al);
}

function calcMACD(closes) {
  if (closes.length < 35) return { hist: 0 };
  const k12 = 2 / 13;
  const k26 = 2 / 27;
  const k9 = 2 / 10;
  let e12 = closes[0];
  let e26 = closes[0];
  const ml = [];
  for (let i = 1; i < closes.length; i++) {
    e12 = closes[i] * k12 + e12 * (1 - k12);
    e26 = closes[i] * k26 + e26 * (1 - k26);
    if (i >= 25) ml.push(e12 - e26);
  }
  if (!ml.length) return { hist: 0 };
  let sig = ml[0];
  for (let i = 1; i < ml.length; i++) {
    sig = ml[i] * k9 + sig * (1 - k9);
  }
  return { hist: ml[ml.length - 1] - sig };
}

function calcADX(candles, p = 14) {
  if (candles.length < p + 2) return 15;
  const sl = candles.slice(-(p + 1));
  let pdm = 0;
  let ndm = 0;
  let tr = 0;
  for (let i = 1; i < sl.length; i++) {
    const h = sl[i].high;
    const l = sl[i].low;
    const ph = sl[i - 1].high;
    const pl = sl[i - 1].low;
    const pc = sl[i - 1].close;
    const um = h - ph;
    const dm = pl - l;
    pdm += um > dm && um > 0 ? um : 0;
    ndm += dm > um && dm > 0 ? dm : 0;
    tr += Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  if (!tr) return 15;
  const pdi = (pdm / tr) * 100;
  const ndi = (ndm / tr) * 100;
  const s = pdi + ndi;
  return s > 0 ? (Math.abs(pdi - ndi) / s) * 100 : 15;
}

function calcEMA(closes, period) {
  if (!closes.length) return 0;
  const k = 2 / (period + 1);
  let e = closes[0];
  for (let i = 1; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
  }
  return e;
}

function calcVWAP(candles) {
  if (!candles?.length) return 0;
  let pv = 0;
  let vv = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += tp * v;
    vv += v;
  }
  if (vv === 0) return candles[candles.length - 1].close;
  return pv / vv;
}

module.exports = {
  calcRSI,
  calcMACD,
  calcADX,
  calcEMA,
  calcVWAP,
};
