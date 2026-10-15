import { describe, expect, it } from "vitest";
import type { CausalCandle } from "./causal-pivot.js";
import { IctCompositeEngine } from "./composite-engine.js";
import { defaultIctEngineConfig, type IctStateCompositeSnapshot } from "./config.js";
import { applyHtfBiasRule } from "./htf-bias-variants.js";

/**
 * A daily zigzag: higher highs and lows, then lower highs and lows, then a bounce.
 *
 * Highs and lows hang off the close, not the open: each bar opens at the previous close, so equal highs at a turning
 * point would otherwise disqualify the pivot. On this series the engine goes BULLISH, turns BEARISH at day 58 and
 * stays BEARISH to the end, through a rally that closes above every earlier swing high -- the state BANKNIFTY and
 * NIFTY were in on 2026-10-15.
 */
function vShape(): CausalCandle[] {
  const waypoints = [100, 130, 112, 150, 128, 170, 140, 156, 118, 138, 96, 118, 80, 125, 106, 150, 128, 160];
  const closes: number[] = [];
  for (let w = 0; w + 1 < waypoints.length; w += 1) {
    for (let k = 0; k < 6; k += 1) closes.push(waypoints[w]! + ((waypoints[w + 1]! - waypoints[w]!) * k) / 6);
  }
  closes.push(waypoints[waypoints.length - 1]!);
  const start = Date.UTC(2026, 0, 1);
  return closes.map((close, i) => ({
    id: `d${i}`,
    openTime: new Date(start + i * 24 * 60 * 60 * 1000),
    open: i === 0 ? close : closes[i - 1]!,
    high: close + 1,
    low: close - 1,
    close,
    volume: 0,
  }));
}

function ownStructureSnapshots(candles: readonly CausalCandle[]): IctStateCompositeSnapshot[] {
  const engine = new IctCompositeEngine({ ...defaultIctEngineConfig, biasSource: "OWN_STRUCTURE" });
  return candles.map((_, i) => engine.processCandle(candles, i));
}

/** The same snapshots with the order-block list replaced: empty, or a bullish and a bearish block covering every price. */
function withBlocks(snapshots: readonly IctStateCompositeSnapshot[], blocks: "NONE" | "EVERYWHERE"): IctStateCompositeSnapshot[] {
  const cover = (type: "BULLISH" | "BEARISH") => ({ type, top: 1e9, bottom: -1e9, state: "FRESH" }) as unknown as IctStateCompositeSnapshot["zones"]["activeObs"][number];
  return snapshots.map((snapshot) => ({
    ...snapshot,
    zones: { ...snapshot.zones, activeObs: blocks === "NONE" ? [] : [cover("BULLISH"), cover("BEARISH")] },
  }));
}

describe("applyHtfBiasRule", () => {
  const candles = vShape();
  const snapshots = ownStructureSnapshots(candles);
  const control = snapshots.map((snapshot) => snapshot.bias.bias);

  it("returns exactly the engine's own bias for OWN_STRUCTURE", () => {
    expect(applyHtfBiasRule("OWN_STRUCTURE", candles, snapshots)).toEqual(control);
  });

  it("is only an override: it matches the control until a swing is broken against the bias", () => {
    const internal = applyHtfBiasRule("INTERNAL_CHOCH", candles, snapshots);
    const firstDifference = internal.findIndex((bias, i) => bias !== control[i]);
    // The decline breaks the latest swing low while the base engine is still BULLISH: the variant is early, not different.
    expect(firstDifference).toBeGreaterThan(0);
    expect(control[firstDifference]).toBe("BULLISH");
    expect(internal[firstDifference]).toBe("BEARISH");
    expect(internal.slice(0, firstDifference)).toEqual(control.slice(0, firstDifference));
  });

  // The case this exists for: the bounce closes above the latest swing high while the base engine stays BEARISH.
  it("reads the bounce as BULLISH while the base engine is still BEARISH, and flips both ways", () => {
    const internal = applyHtfBiasRule("INTERNAL_CHOCH", candles, snapshots);
    const lastDay = candles.length - 1;
    expect(control[lastDay]).toBe("BEARISH");
    expect(internal[lastDay]).toBe("BULLISH");
    expect(internal.some((bias, i) => bias === "BEARISH" && control[i] === "BULLISH")).toBe(true);
  });

  it("is causal: a prefix of the series gives the prefix of the result", () => {
    const full = applyHtfBiasRule("INTERNAL_CHOCH", candles, snapshots);
    for (const cut of [30, 55, 70, 85]) {
      expect(applyHtfBiasRule("INTERNAL_CHOCH", candles.slice(0, cut), snapshots.slice(0, cut))).toEqual(full.slice(0, cut));
    }
  });

  it("gives the control back for ZONE_TAP_CHOCH when no order block was tapped", () => {
    expect(applyHtfBiasRule("ZONE_TAP_CHOCH", candles, withBlocks(snapshots, "NONE"))).toEqual(control);
  });

  it("equals INTERNAL_CHOCH when a matching order block covers every swing, so the zone is the only difference", () => {
    const internal = applyHtfBiasRule("INTERNAL_CHOCH", candles, snapshots);
    expect(applyHtfBiasRule("ZONE_TAP_CHOCH", candles, withBlocks(snapshots, "EVERYWHERE"))).toEqual(internal);
  });

  it("never invents a bias where the engine has none", () => {
    const rule = applyHtfBiasRule("INTERNAL_CHOCH", candles, snapshots);
    control.forEach((bias, i) => {
      if (bias !== "BULLISH" && bias !== "BEARISH") expect(rule[i]).toBe(bias);
    });
  });
});
