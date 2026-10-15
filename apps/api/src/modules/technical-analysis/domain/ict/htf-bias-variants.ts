import type { IctBiasDirection } from "./bias.js";
import { findConfirmedPivotAt, type CausalCandle, type ConfirmedPivot } from "./causal-pivot.js";
import type { IctStateCompositeSnapshot } from "./config.js";

/**
 * Research-only variants of the DAILY bias, for the 2026-10-15 comparison (docs/2026-10-15-ict-htf-bias-variants-protocol.md).
 *
 * `OWN_STRUCTURE` is what ships: the daily swing structure's trend. It flips only on a close beyond the last
 * confirmed lower high / higher low, and on 2026-10-15 that was BANKNIFTY 58,025 and NIFTY 23,489 -- so the bias
 * stayed BEARISH through a 4% and a 2% bounce. The variants ask whether reading a nearer structure shift as the
 * bias would have helped. Nothing live uses them: the backtest selects one with `--ict-htf-bias-rule`.
 *
 * Both variants are an OVERRIDE of the base bias, so wherever they do not fire the series equals the control's.
 */
export type HtfBiasRule = "OWN_STRUCTURE" | "INTERNAL_CHOCH" | "ZONE_TAP_CHOCH";

export const HTF_BIAS_RULES: readonly HtfBiasRule[] = ["OWN_STRUCTURE", "INTERNAL_CHOCH", "ZONE_TAP_CHOCH"];

/** Pivot length of the daily swing points the variants watch: the engine's own default. */
const SWING_PIVOT_LENGTH = 3;
/** How far past an order block's edge a swing point may sit and still count as having tapped it, in daily ATRs. */
const ZONE_TAP_ATR_SLACK = 0.5;

function tappedMatchingZone(
  direction: "BULLISH" | "BEARISH",
  swing: ConfirmedPivot,
  snapshot: IctStateCompositeSnapshot,
): boolean {
  const slack = ZONE_TAP_ATR_SLACK * (snapshot.atr14 ?? 0);
  return snapshot.zones.activeObs.some((block) => {
    if (block.state === "INVALIDATED") return false;
    if (direction === "BULLISH") {
      // A demand zone: the swing low went into it (at or below its top, no further below its bottom than the slack).
      return block.type === "BULLISH" && swing.price <= block.top && swing.price >= block.bottom - slack;
    }
    return block.type === "BEARISH" && swing.price >= block.bottom && swing.price <= block.top + slack;
  });
}

/**
 * The bias per daily bucket under a variant rule, parallel to `candles`.
 *
 * `snapshots[i]` must be the OWN_STRUCTURE engine's snapshot after bucket `i`, so the base bias, the order blocks
 * and the ATR at each bucket come from exactly the data the control sees. Causal: bucket `i` uses buckets `0..i`.
 */
export function applyHtfBiasRule(
  rule: HtfBiasRule,
  candles: readonly CausalCandle[],
  snapshots: readonly IctStateCompositeSnapshot[],
): IctBiasDirection[] {
  const out: IctBiasDirection[] = [];
  if (rule === "OWN_STRUCTURE") {
    for (const snapshot of snapshots) out.push(snapshot.bias.bias);
    return out;
  }

  let lastSwingHigh: ConfirmedPivot | null = null;
  let lastSwingLow: ConfirmedPivot | null = null;
  let override: "BULLISH" | "BEARISH" | null = null;
  let previousBase: IctBiasDirection | null = null;

  for (let i = 0; i < candles.length; i += 1) {
    const pivots = findConfirmedPivotAt(candles, i, SWING_PIVOT_LENGTH);
    if (pivots.high) lastSwingHigh = pivots.high;
    if (pivots.low) lastSwingLow = pivots.low;

    const snapshot = snapshots[i]!;
    const base = snapshot.bias.bias;
    // The structural engine changed its own mind: defer to it, and let a fresh override form from there.
    if (previousBase !== null && base !== previousBase) override = null;
    previousBase = base;

    if (base !== "BULLISH" && base !== "BEARISH") {
      out.push(base);
      continue;
    }

    const effective: "BULLISH" | "BEARISH" = override ?? base;
    const close = candles[i]!.close;
    let flipTo: "BULLISH" | "BEARISH" | null = null;
    if (effective === "BEARISH" && lastSwingHigh !== null && close > lastSwingHigh.price) {
      flipTo = "BULLISH";
      // The swing point just left is the low that started the move: it must have tapped a demand zone.
      if (rule === "ZONE_TAP_CHOCH" && (lastSwingLow === null || !tappedMatchingZone("BULLISH", lastSwingLow, snapshot))) flipTo = null;
    } else if (effective === "BULLISH" && lastSwingLow !== null && close < lastSwingLow.price) {
      flipTo = "BEARISH";
      if (rule === "ZONE_TAP_CHOCH" && (lastSwingHigh === null || !tappedMatchingZone("BEARISH", lastSwingHigh, snapshot))) flipTo = null;
    }
    if (flipTo !== null) override = flipTo === base ? null : flipTo;

    out.push(override ?? base);
  }
  return out;
}
