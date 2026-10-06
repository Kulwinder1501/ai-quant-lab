import { describe, it, expect } from "vitest";
import { IctBiasTracker } from "./bias.js";
import { IctStructureTracker } from "./structure.js";
import { IctSessionLevelTracker } from "./session-levels.js";
import { NSE_IST_PROFILE, XAUUSD_OANDA_PROFILE } from "../../../platform/calendar/instrument-profile.js";
import type { CausalCandle } from "./causal-pivot.js";

function makeIstCandle(
  dateStr: string,
  hour: number,
  minute: number,
  open: number,
  high: number,
  low: number,
  close: number
): CausalCandle {
  const [y, m, d] = dateStr.split("-").map(Number);
  const istMinutes = hour * 60 + minute;
  const utcMinutes = istMinutes - 330;
  const date = new Date(Date.UTC(y, m - 1, d, 0, utcMinutes));
  return {
    id: `c-${dateStr}-${hour}-${minute}`,
    openTime: date,
    open,
    high,
    low,
    close,
    volume: 100,
  };
}

describe("IctBiasTracker", () => {
  it("determines OLHC bullish daily template when session low precedes high", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 105, 95, 98), // Low formed at 95
      makeIstCandle("2026-01-05", 9, 20, 98, 110, 97, 108), // High formed at 110
      makeIstCandle("2026-01-05", 9, 25, 108, 112, 107, 111), // Higher high at 112
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      const sStruct = structTracker.processCandle(candles, i);
      const sSession = sessionTracker.processCandle(candles, i);
      snap = biasTracker.processCandle(candles, i, sStruct, sSession, "OWN_STRUCTURE");
    }

    expect(snap.dailyTemplate).toBe("OLHC");
  });

  it("determines OHLC bearish daily template when session high precedes low", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 112, 99, 110), // High formed at 112
      makeIstCandle("2026-01-05", 9, 20, 110, 110, 92, 94), // Low formed at 92
      makeIstCandle("2026-01-05", 9, 25, 94, 96, 90, 91), // Lower low at 90
    ];

    let snap: any;
    for (let i = 0; i < candles.length; i++) {
      const sStruct = structTracker.processCandle(candles, i);
      const sSession = sessionTracker.processCandle(candles, i);
      snap = biasTracker.processCandle(candles, i, sStruct, sSession, "OWN_STRUCTURE");
    }

    expect(snap.dailyTemplate).toBe("OHLC");
  });

  it("treats a PDL sweep as confirmation of the higher-timeframe bias, not a source of it", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker();

    const candles: CausalCandle[] = [
      makeIstCandle("2026-01-05", 9, 15, 100, 110, 95, 105), // Day 1 PDH=110, PDL=95
    ];
    let sStruct = structTracker.processCandle(candles, 0);
    let sSession = sessionTracker.processCandle(candles, 0);
    biasTracker.processCandle(candles, 0, sStruct, sSession, "OWN_STRUCTURE");

    // Day 2 Bar 1: Sweeps PDL (95) with Low 93, but closes 97 (SWEEP)
    candles.push(makeIstCandle("2026-01-06", 9, 15, 98, 99, 93, 97));
    sStruct = structTracker.processCandle(candles, 1);
    sSession = sessionTracker.processCandle(candles, 1);
    /*
     * Sweep alone, with no higher-timeframe read: UNKNOWN, not BULLISH.
     *
     * Bias is the higher-timeframe narrative (lecture 9: monthly -> weekly -> daily). A sweep is a
     * confirmation event on the execution timeframe; on its own it is not evidence of direction, and
     * missing evidence fails closed rather than resolving to NEUTRAL.
     */
    const noHtf = biasTracker.processCandle(candles, 1, sStruct, sSession, "OWN_STRUCTURE");
    expect(noHtf.bias).toBe("UNKNOWN");

    // Sweep AGREEING with a bullish higher timeframe: confirmed, full expansion expected.
    const agreeing = biasTracker.processCandle(candles, 1, sStruct, sSession, "HIGHER_TIMEFRAME", "BULLISH");
    expect(agreeing.bias).toBe("BULLISH");
    expect(agreeing.reasons[0]).toContain("swept with the higher-timeframe BULLISH bias");

    // Sweep AGAINST a bearish higher timeframe: recorded, but bias stays bearish. Lecture 5 -- a
    // counter-trend sweep is a pop to the nearest POI, not a reversal.
    const against = biasTracker.processCandle(candles, 1, sStruct, sSession, "HIGHER_TIMEFRAME", "BEARISH");
    expect(against.bias).toBe("BEARISH");
    expect(against.reasons.join(" ")).toContain("Counter-trend BULLISH sweep");

    const snap = agreeing;
    expect(snap.dealingRange?.equilibrium).toBe(102.5); // (110 + 95)/2
    expect(snap.dealingRange?.isDiscount(97)).toBe(true);
    expect(snap.dealingRange?.isPremium(105)).toBe(true);
  });

  /*
   * Investigated concern: bias.ts picks `structure.lastHH && structure.lastHL` unconditionally,
   * ahead of `lastLH && lastLL`, with no check on `structure.trend`. The worry was that after a
   * bullish->bearish CHoCH, a stale (pre-reversal) `lastHH`/`lastHL` pair could still both be
   * non-null and get picked over the fresh `lastLH`/`lastLL` pair that actually describes the new
   * downtrend -- silently mispricing premium/discount during exactly the transition that matters
   * most.
   *
   * Traced through `IctStructureTracker.processCandle` (structure.ts): a bullish->bearish CHoCH
   * (the `lastHL` break) unconditionally nulls `this.lastHL` in the same branch that flips
   * `trend` to BEARISH, and nothing in the BEARISH branches ever sets `lastHL` again (every
   * assignment site is gated on `trend === "BULLISH"` or `"NEUTRAL"`). So for the entire lifetime
   * of a bearish trend, `structure.lastHL` is provably null -- bias.ts's first condition can never
   * fire, and it always falls through to `lastLH && lastLL`, which is exactly the pair the current
   * downtrend maintains. `lastHH` *does* persist unchanged through the whole bearish trend (a
   * separate, already-documented quirk -- see market-data.routes.ts's `toChartIctStructure` doc
   * comment -- kept deliberately because other consumers, e.g. liquidity.ts's external-liquidity
   * levels, treat an untapped prior high as a live liquidity pool regardless of current trend), but
   * because its partner `lastHL` is null, bias.ts never combines the two. The hypothesized failure
   * mode does not occur; this locks that invariant in.
   */
  it("does not let a stale bullish HH/HL pair leak into the dealing range once structure has flipped bearish", () => {
    const biasTracker = new IctBiasTracker();
    const structTracker = new IctStructureTracker(1);
    const sessionTracker = new IctSessionLevelTracker();

    function candle(index: number, open: number, high: number, low: number, close: number): CausalCandle {
      return {
        id: `c-${index}`,
        openTime: new Date(Date.UTC(2026, 0, 1, 9, 15 + index * 5)),
        open,
        high,
        low,
        close,
        volume: 100,
      };
    }

    // A slow directional drift (0.6/bar) with a wide (+/-4) alternating zigzag layered on top, so
    // pivots keep confirming every other bar while the overall level still trends. Up for bars
    // 0-40 (establishes a HH/HL pair), down for 40-90 (drives a bullish->bearish CHoCH, then a
    // genuine downtrend), up again from 91 (drives the mirror bearish->bullish CHoCH).
    function coarseDrift(i: number): number {
      if (i <= 40) return 0.6 * i;
      if (i <= 90) return 0.6 * 40 - 0.6 * (i - 40);
      return 0.6 * 40 - 0.6 * 50 + 0.6 * (i - 90);
    }

    const candles: CausalCandle[] = [];
    for (let i = 0; i < 100; i++) {
      const base = 100 + coarseDrift(i) + (i % 2 === 0 ? 0 : 6);
      candles.push(candle(i, base, base + 4, base - 4, base + (i % 2 === 0 ? -1 : 1)));
    }

    let lastStruct;
    let lastBias;
    for (let i = 0; i < candles.length; i++) {
      lastStruct = structTracker.processCandle(candles, i);
      const sess = sessionTracker.processCandle(candles, i);
      lastBias = biasTracker.processCandle(candles, i, lastStruct, sess, "OWN_STRUCTURE");

      // Snapshot the still-bullish state right before the reversal (bar 78): HH/HL both set and
      // correctly driving the range.
      if (i === 78) {
        expect(lastStruct.trend).toBe("BULLISH");
        expect(lastStruct.lastHH?.price).toBe(113);
        expect(lastStruct.lastHL?.price).toBe(99.6);
        expect(lastBias.dealingRange?.rangeHigh).toBe(113);
        expect(lastBias.dealingRange?.rangeLow).toBe(99.6);
      }

      // Bar 91: solidly bearish, well past the CHoCH at bar 80. The stale bullish lastHH (113)
      // persists (the documented quirk), but its partner lastHL is null -- so the dealing range
      // must come from the current-trend lastLH/lastLL pair, not from lastHH.
      if (i === 99) {
        expect(lastStruct.trend).toBe("BEARISH");
        expect(lastStruct.lastHH?.price).toBe(113); // stale, but harmless: see below
        expect(lastStruct.lastHL).toBeNull(); // <- the invariant that makes it harmless
        expect(lastStruct.lastLH?.price).toBe(113);
        expect(lastStruct.lastLL?.price).toBe(93.6);
        expect(lastBias.dealingRange?.rangeHigh).toBe(lastStruct.lastLH?.price);
        expect(lastBias.dealingRange?.rangeLow).toBe(93.6);
      }
    }
  });
});

describe("IctBiasTracker instrument profile wiring (G1)", () => {
  // Three bars, all after gold's 18:00 NY open on 2026-07-13 EXCEPT the first, which sits 15:00-19:00
  // NY and so belongs to the PRIOR gold session date -- but all three land after IST midnight on the
  // same calendar day, so NSE's fixed +5:30 profile buckets all three into one session.
  const barBeforeOpen: CausalCandle = {
    id: "xau-before-open",
    openTime: new Date("2026-07-13T19:00:00.000Z"), // 15:00 NY EDT
    open: 100, high: 105, low: 95, close: 102, volume: 10,
  };
  const barAfterOpen: CausalCandle = {
    id: "xau-after-open",
    openTime: new Date("2026-07-13T23:00:00.000Z"), // 19:00 NY EDT
    open: 102, high: 112, low: 101, close: 110, volume: 10,
  };
  const barThird: CausalCandle = {
    id: "xau-third",
    openTime: new Date("2026-07-14T05:00:00.000Z"), // 01:00 NY EDT, still before today's 18:00 open
    open: 110, high: 111, low: 108, close: 109, volume: 10,
  };
  const candles = [barBeforeOpen, barAfterOpen, barThird];

  function lastBiasWith(profile: typeof NSE_IST_PROFILE) {
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker(profile);
    const biasTracker = new IctBiasTracker();
    let snap;
    for (let i = 0; i < candles.length; i++) {
      const struct = structTracker.processCandle(candles, i);
      const session = sessionTracker.processCandle(candles, i);
      snap = biasTracker.processCandle(candles, i, struct, session, "OWN_STRUCTURE", undefined, profile);
    }
    return snap!;
  }

  it("defaults to NSE_IST_PROFILE, matching an explicit NSE_IST_PROFILE call byte-for-byte", () => {
    const structTracker = new IctStructureTracker(2);
    const sessionTracker = new IctSessionLevelTracker(); // default profile too
    const biasTracker = new IctBiasTracker();
    let withDefault;
    for (let i = 0; i < candles.length; i++) {
      const struct = structTracker.processCandle(candles, i);
      const session = sessionTracker.processCandle(candles, i);
      withDefault = biasTracker.processCandle(candles, i, struct, session, "OWN_STRUCTURE"); // no profile arg
    }
    expect(withDefault).toEqual(lastBiasWith(NSE_IST_PROFILE));
  });

  it("resolves a wider same-session walk-back under NSE's fixed-offset profile than under XAU's NY-local one", () => {
    // Under NSE, all three bars share one IST calendar date, so the session-start walk-back reaches
    // all the way back to bar 0 -- 3 bars is enough for a resolved daily template.
    const nseBias = lastBiasWith(NSE_IST_PROFILE);
    expect(nseBias.dailyTemplate).toBe("OLHC"); // session low (bar 0) precedes session high (bar 1)

    // Under XAU_USD's NY-local 18:00 boundary, bar 0 belongs to the PRIOR session, so the walk-back
    // stops at bar 1 -- only 2 bars in the current session, below the 3-bar minimum for a template.
    const xauBias = lastBiasWith(XAUUSD_OANDA_PROFILE);
    expect(xauBias.dailyTemplate).toBe("UNKNOWN");
  });
});
