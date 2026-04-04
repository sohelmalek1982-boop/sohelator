#!/usr/bin/env python3
"""
JTrader-style ORB proxy backtest on SPY 1-hour bars (NQ bot preview).

Uses `spy_1hour_full.csv` as proxy data. Strategy (for NQ port):
- First two RTH bars define opening range (OR) high / low.
- First close above OR high → long; first close below OR low → short.
- Stop at opposite OR side; profit target at R * opening-range width (R = 1.5).
- One trade per session; remainder of day manages stop/target or MOC on last bar.

Stdlib only — run: python matrix/backtest_jtrader.py
"""

from __future__ import annotations

import csv
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent
CSV_PATH = ROOT / "spy_1hour_full.csv"

RISK_REWARD = 1.5


@dataclass
class Bar:
    ts: datetime
    o: float
    h: float
    l: float
    c: float
    v: float


def load_bars(path: Path) -> list[Bar]:
    out: list[Bar] = []
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


def session_date(bar: Bar) -> str:
    return bar.ts.strftime("%Y-%m-%d")


def day_pnl(day_bars: list[Bar]) -> Optional[float]:
    if len(day_bars) < 3:
        return None
    or_high = max(day_bars[0].h, day_bars[1].h)
    or_low = min(day_bars[0].l, day_bars[1].l)
    width = or_high - or_low
    if width <= 0 or day_bars[0].c <= 0:
        return None
    if width / day_bars[0].c < 0.0003:
        return None

    entry: float | None = None
    direction: str | None = None
    stop = 0.0
    target = 0.0

    for b in day_bars[2:]:
        if entry is None:
            if b.c > or_high:
                entry = b.c
                direction = "L"
                stop = or_low
                target = entry + RISK_REWARD * width
            elif b.c < or_low:
                entry = b.c
                direction = "S"
                stop = or_high
                target = entry - RISK_REWARD * width
            continue

        if direction == "L":
            if b.l <= stop:
                return stop - entry
            if b.h >= target:
                return target - entry
        else:
            if b.h >= stop:
                return entry - stop
            if b.l <= target:
                return entry - target

    if entry is None or direction is None:
        return None
    last = day_bars[-1].c
    if direction == "L":
        return last - entry
    return entry - last


def main() -> None:
    if not CSV_PATH.is_file():
        print(f"Missing {CSV_PATH} — place spy_1hour_full.csv next to this script.")
        raise SystemExit(1)

    bars = load_bars(CSV_PATH)
    by_day: dict[str, list[Bar]] = defaultdict(list)
    for b in bars:
        by_day[session_date(b)].append(b)
    for d in by_day:
        by_day[d].sort(key=lambda x: x.ts)

    wins = 0
    losses = 0
    pnl_sum = 0.0
    trades = 0
    skipped = 0

    for _day, day_bars in sorted(by_day.items()):
        pnl = day_pnl(day_bars)
        if pnl is None:
            skipped += 1
            continue
        trades += 1
        pnl_sum += pnl
        if pnl > 0:
            wins += 1
        elif pnl < 0:
            losses += 1

    win_rate = (wins / trades * 100.0) if trades else 0.0
    print("=== JTrader ORB proxy (SPY 1h) ===")
    print(f"CSV: {CSV_PATH}")
    print(f"Bars loaded: {len(bars)}")
    print(f"Sessions traded: {trades}  Wins: {wins}  Losses: {losses}  Win rate: {win_rate:.2f}%")
    print(f"Sum of $ move per share (proxy P&L units): {pnl_sum:.4f}")
    print(f"Sessions skipped (no trade / thin OR): {skipped}")


if __name__ == "__main__":
    main()
