import { describe, expect, it } from "vitest";
import { guessSide, LiveSideSplit, type SideSplitTick } from "./live-side-split.js";

const SYMBOL = "NSE:NIFTY26NOVFUT";
/** 10:00 IST on 2026-10-27 (a Tuesday), well inside the regular session. */
const T = Date.parse("2026-10-27T04:30:00.000Z");

function tick(overrides: Partial<SideSplitTick>): SideSplitTick {
  return { symbol: SYMBOL, ltp: 25_000, bid: 24_999.9, ask: 25_000.1, volume: 1_000, ...overrides };
}

describe("guessSide", () => {
  it("calls a price at or above the ask a buy and at or below the bid a sell", () => {
    expect(guessSide(25_000.1, 24_999.9, 25_000.1)).toBe("BUY");
    expect(guessSide(25_000.3, 24_999.9, 25_000.1)).toBe("BUY");
    expect(guessSide(24_999.9, 24_999.9, 25_000.1)).toBe("SELL");
    expect(guessSide(24_999.5, 24_999.9, 25_000.1)).toBe("SELL");
  });

  it("will not name a side strictly inside the spread, or without a usable two-sided quote", () => {
    expect(guessSide(25_000, 24_999.9, 25_000.1)).toBe("UNKNOWN");
    expect(guessSide(25_000, null, 25_000.1)).toBe("UNKNOWN");
    expect(guessSide(25_000, 24_999.9, null)).toBe("UNKNOWN");
    expect(guessSide(25_000, 0, 25_000.1)).toBe("UNKNOWN");
    // A crossed book (ask below bid) is not a quote anyone dealt at.
    expect(guessSide(25_000, 25_000.2, 25_000.1)).toBe("UNKNOWN");
  });
});

describe("LiveSideSplit", () => {
  it("counts nothing from the first tick: it only sets the volume counter", () => {
    const split = new LiveSideSplit();
    split.record(tick({ volume: 5_000 }), T);
    const snap = split.snapshot(SYMBOL, 5, T);
    expect(snap?.totals.total).toBe(0);
    expect(snap?.rows).toEqual([]);
    expect(snap?.unknownShare).toBeNull();
  });

  it("assigns each advance, whole, to the later tick's price and side", () => {
    const split = new LiveSideSplit();
    split.record(tick({ volume: 1_000 }), T);
    split.record(tick({ ltp: 25_000.1, volume: 1_130 }), T + 1_000); // at the ask: +130 buy
    split.record(tick({ ltp: 24_999.9, volume: 1_190 }), T + 2_000); // at the bid: +60 sell
    split.record(tick({ ltp: 25_000.0, volume: 1_250 }), T + 3_000); // inside: +60 unknown
    const snap = split.snapshot(SYMBOL, 5, T + 3_000)!;
    expect(snap.totals).toEqual({ buy: 130, sell: 60, unknown: 60, total: 250 });
    expect(snap.unknownShare).toBeCloseTo(60 / 250, 12);
    expect(snap.advances).toBe(3);
    expect(snap.since).toBe(new Date(T + 1_000).toISOString());
    expect(snap.last).toBe(new Date(T + 3_000).toISOString());
  });

  it("conserves volume: the total equals the counter's rise over the counted ticks", () => {
    const split = new LiveSideSplit();
    let volume = 10_000;
    split.record(tick({ volume }), T);
    const rises = [30, 0, 95, 65, 5, 400];
    rises.forEach((rise, index) => {
      volume += rise;
      split.record(tick({ ltp: 25_000 + index * 0.05, volume }), T + (index + 1) * 1_000);
    });
    expect(split.snapshot(SYMBOL, 5, T + 10_000)!.totals.total).toBe(rises.reduce((a, b) => a + b, 0));
  });

  it("counts a counter that goes down as a reset and never as negative volume", () => {
    const split = new LiveSideSplit();
    split.record(tick({ volume: 2_000 }), T);
    split.record(tick({ volume: 1_500 }), T + 1_000);
    split.record(tick({ ltp: 25_000.1, volume: 1_600 }), T + 2_000); // +100 from the lowered counter
    const snap = split.snapshot(SYMBOL, 5, T + 2_000)!;
    expect(snap.counterResets).toBe(1);
    expect(snap.totals.total).toBe(100);
  });

  it("follows the counter outside the regular session but counts nothing there", () => {
    const split = new LiveSideSplit();
    const preOpen = Date.parse("2026-10-27T03:40:00.000Z"); // 09:10 IST
    const afterOpen = Date.parse("2026-10-27T03:50:00.000Z"); // 09:20 IST
    split.record(tick({ volume: 1_000 }), preOpen - 60_000);
    split.record(tick({ ltp: 25_000.1, volume: 90_000 }), preOpen); // a big pre-open rise: not counted
    split.record(tick({ ltp: 25_000.1, volume: 90_040 }), afterOpen); // +40 in session: counted
    expect(split.snapshot(SYMBOL, 5, afterOpen)!.totals.total).toBe(40);
  });

  it("does not count the closing minute's end or anything after 15:30 IST", () => {
    const split = new LiveSideSplit();
    const lastMinute = Date.parse("2026-10-27T09:59:00.000Z"); // 15:29 IST
    const closed = Date.parse("2026-10-27T10:00:30.000Z"); // 15:30:30 IST
    split.record(tick({ volume: 1_000 }), lastMinute - 1_000);
    split.record(tick({ ltp: 25_000.1, volume: 1_010 }), lastMinute); // counted
    split.record(tick({ ltp: 25_000.1, volume: 1_500 }), closed); // after the close: not counted
    expect(split.snapshot(SYMBOL, 5, closed)!.totals.total).toBe(10);
  });

  it("rows are rowPoints tall and aligned to multiples of it, edges inclusive below and exclusive above", () => {
    const split = new LiveSideSplit();
    split.record(tick({ ltp: 24_000.05, volume: 1_000 }), T);
    split.record(tick({ ltp: 24_000.05, volume: 1_010 }), T + 1_000);
    split.record(tick({ ltp: 24_004.95, volume: 1_030 }), T + 2_000);
    split.record(tick({ ltp: 24_005.0, volume: 1_070 }), T + 3_000);
    const rows = split.snapshot(SYMBOL, 5, T + 3_000)!.rows;
    expect(rows.map((row) => [row.low, row.high, row.buy + row.sell + row.unknown])).toEqual([
      [24_000, 24_005, 30], // 10 at 24000.05 and 20 at 24004.95
      [24_005, 24_010, 40], // 24005.00 starts the next row
    ]);
    // The same volume rebuilt with 10-point rows lands in one row.
    expect(split.snapshot(SYMBOL, 10, T + 3_000)!.rows.map((row) => [row.low, row.high, row.buy + row.sell + row.unknown]))
      .toEqual([[24_000, 24_010, 70]]);
  });

  it("starts afresh on a new IST date and has nothing for yesterday's date", () => {
    const split = new LiveSideSplit();
    split.record(tick({ volume: 1_000 }), T);
    split.record(tick({ ltp: 25_000.1, volume: 1_100 }), T + 1_000);
    const nextDay = T + 86_400_000;
    expect(split.snapshot(SYMBOL, 5, nextDay)).toBeNull();
    split.record(tick({ volume: 900 }), nextDay); // the new day's counter starts lower: not a reset of yesterday's
    split.record(tick({ ltp: 25_000.1, volume: 950 }), nextDay + 1_000);
    const snap = split.snapshot(SYMBOL, 5, nextDay + 1_000)!;
    expect(snap.totals.total).toBe(50);
    expect(snap.counterResets).toBe(0);
  });

  it("keeps symbols apart and returns null for one never heard", () => {
    const split = new LiveSideSplit();
    split.record(tick({ symbol: "NSE:A", volume: 100 }), T);
    split.record(tick({ symbol: "NSE:A", ltp: 25_000.1, volume: 150 }), T + 1_000);
    split.record(tick({ symbol: "NSE:B", volume: 100 }), T);
    expect(split.snapshot("NSE:A", 5, T + 1_000)!.totals.total).toBe(50);
    expect(split.snapshot("NSE:B", 5, T + 1_000)!.totals.total).toBe(0);
    expect(split.snapshot("NSE:C", 5, T + 1_000)).toBeNull();
  });

  it("ignores ticks with no usable volume or price", () => {
    const split = new LiveSideSplit();
    split.record(tick({ volume: null }), T);
    split.record(tick({ volume: Number.NaN }), T);
    split.record(tick({ ltp: 0, volume: 100 }), T);
    expect(split.snapshot(SYMBOL, 5, T)).toBeNull();
  });

  it("attach listens to tick events and the returned function stops it", () => {
    const listeners = new Set<(t: SideSplitTick) => void>();
    const source = {
      on: (_event: "tick", listener: (t: SideSplitTick) => void) => { listeners.add(listener); return source; },
      off: (_event: "tick", listener: (t: SideSplitTick) => void) => { listeners.delete(listener); return source; },
    };
    const split = new LiveSideSplit();
    const stop = split.attach(source);
    expect(listeners.size).toBe(1);
    stop();
    expect(listeners.size).toBe(0);
  });
});
