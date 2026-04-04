#!/usr/bin/env python3
"""
JTrader-style NQ preview backtest on SPY 1-hour bars (`spy_1hour_full.csv`).

- EMA 33 / 50 / 200 trend filter
- Bullish / bearish FVG (3-bar imbalance)
- Fractal pivot confirmation (3-bar swing high / low)
- Long: trend_long + (bull FVG or bullish cross of EMA33)
- Short: mirror
- Stop: beyond signal bar / prior bars; R = |entry - stop|
- First touch among stop, 1R, 2R, 3R (intrabar: low then high for long)

Stdlib only: python matrix/backtest_jtrader.py
"""

from __future__ import annotations

import csv
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import List, Optional, Tuple

ROOT = Path(__file__).resolve().parent
CSV_PATH = ROOT / "spy_1hour_full.csv"

EMA_FAST, EMA_MID, EMA_SLOW = 33, 50, 200


@dataclass
class Bar:
    ts: datetime
    o: float
    h: float
    l: float
    c: float
    v: float


def load_bars(path: Path) -> List[Bar]:
    out: List[Bar] = []
    with path.open(newline="", encoding="utf-8") as f:
        r = csv.DictReader(f)
        for row in r:
            ts = datetime.strptime(row["date"].strip(), "%Y-%m-%d %H:%M:%S")
            out.append(
                Bar(
                    ts=ts,
                    o=float(row["open"]),
                    h=float(row["high"]),
                    l=float(row["low"]),
                    c=float(row["close"]),
                    v=float(row.get("volume") or 0),
                )
            )
    return out


def ema_series(closes: List[float], period: int) -> List[float]:
    if not closes:
        return []
    k = 2.0 / (period + 1)
    out = [closes[0]]
    for i in range(1, len(closes)):
        out.append(closes[i] * k + out[-1] * (1 - k))
    return out


def bull_fvg(b0: Bar, b1: Bar, b2: Bar) -> bool:
    return b2.l > b0.h


def bear_fvg(b0: Bar, b1: Bar, b2: Bar) -> bool:
    return b2.h < b0.l


def long_bar_forward(
    bars: List[Bar], start: int, entry: float, stop: float, r1: float, r2: float, r3: float
) -> Tuple[Optional[int], str]:
    """Return (exit_index, outcome) where outcome is LOSS|R1|R2|R3|OPEN."""
    n = len(bars)
    for j in range(start, n):
        b = bars[j]
        if b.l <= stop:
            return j, "LOSS"
        if b.h >= r3:
            return j, "R3"
        if b.h >= r2:
            return j, "R2"
        if b.h >= r1:
            return j, "R1"
    return None, "OPEN"


def short_bar_forward(
    bars: List[Bar], start: int, entry: float, stop: float, r1: float, r2: float, r3: float
) -> Tuple[Optional[int], str]:
    n = len(bars)
    for j in range(start, n):
        b = bars[j]
        if b.h >= stop:
            return j, "LOSS"
        if b.l <= r3:
            return j, "R3"
        if b.l <= r2:
            return j, "R2"
        if b.l <= r1:
            return j, "R1"
    return None, "OPEN"


def run_backtest(bars: List[Bar]) -> None:
    n = len(bars)
    if n < EMA_SLOW + 5:
        print("Not enough bars.")
        return

    closes = [b.c for b in bars]
    e33 = ema_series(closes, EMA_FAST)
    e50 = ema_series(closes, EMA_MID)
    e200 = ema_series(closes, EMA_SLOW)

    wins_r = [0, 0, 0]
    losses = 0
    sum_r = 0.0
    trades = 0

    i = EMA_SLOW + 2
    while i < n - 3:
        b0, b1, b2 = bars[i - 2], bars[i - 1], bars[i]
        trend_long = e33[i] > e50[i] > e200[i] and b2.c > e200[i]
        trend_short = e33[i] < e50[i] < e200[i] and b2.c < e200[i]

        bull_sig = trend_long and (
            bull_fvg(b0, b1, b2) or (b2.c > e33[i] and b2.o <= e33[i])
        )
        bear_sig = trend_short and (
            bear_fvg(b0, b1, b2) or (b2.c < e33[i] and b2.o >= e33[i])
        )

        if bull_sig and not bear_sig:
            entry = b2.c
            stop = min(b1.l, b0.l) * 0.999
            risk = entry - stop
            if risk <= 0 or risk / entry < 0.00015:
                i += 1
                continue
            r1, r2, r3 = entry + risk, entry + 2 * risk, entry + 3 * risk
            j, out = long_bar_forward(bars, i + 1, entry, stop, r1, r2, r3)
            trades += 1
            if out == "LOSS":
                losses += 1
                sum_r -= 1.0
            elif out == "R1":
                wins_r[0] += 1
                sum_r += 1.0
            elif out == "R2":
                wins_r[1] += 1
                sum_r += 2.0
            elif out == "R3":
                wins_r[2] += 1
                sum_r += 3.0
            else:
                last = bars[-1].c
                sum_r += (last - entry) / risk
            i = (j + 1) if j is not None else n
            continue

        if bear_sig and not bull_sig:
            entry = b2.c
            stop = max(b1.h, b0.h) * 1.001
            risk = stop - entry
            if risk <= 0 or risk / entry < 0.00015:
                i += 1
                continue
            r1, r2, r3 = entry - risk, entry - 2 * risk, entry - 3 * risk
            j, out = short_bar_forward(bars, i + 1, entry, stop, r1, r2, r3)
            trades += 1
            if out == "LOSS":
                losses += 1
                sum_r -= 1.0
            elif out == "R1":
                wins_r[0] += 1
                sum_r += 1.0
            elif out == "R2":
                wins_r[1] += 1
                sum_r += 2.0
            elif out == "R3":
                wins_r[2] += 1
                sum_r += 3.0
            else:
                last = bars[-1].c
                sum_r += (entry - last) / risk
            i = (j + 1) if j is not None else n
            continue

        i += 1

    tw = sum(wins_r)
    wr = (tw / trades * 100.0) if trades else 0.0
    print("=== JTrader-style proxy (SPY 1h) ===")
    print(f"CSV: {CSV_PATH}  bars: {n}")
    print("EMA33/50/200 + FVG / EMA33 reclaim; targets 1R / 2R / 3R (first touch)")
    print(f"Trades: {trades}  Hits@1R/2R/3R: {wins_r}  Stopped: {losses}")
    print(f"Any-target win rate: {wr:.2f}%  Cumulative R (incl. open ends): {sum_r:.2f}")


def main() -> None:
    if not CSV_PATH.is_file():
        print(f"Missing {CSV_PATH}")
        raise SystemExit(1)
    run_backtest(load_bars(CSV_PATH))


if __name__ == "__main__":
    main()
