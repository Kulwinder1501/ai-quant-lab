import { assessTapeLiveness } from "../../market-data/domain/tape-liveness.js";
import type { CandleLike } from "./pattern-context-calculator.js";
import { isUsableVolume } from "./volume-semantics.js";

/**
 * Whether a stored bar carries any observation at all, or is a placeholder the feed emitted.
 *
 * ## The measured defect
 *
 * From 2026-08-03 the Fyers *index* feed freezes for 15:16-15:29 IST every session without
 * exception. Across that block all four OHLC values are the identical constant — 2026-08-25
 * BANKNIFTY sat pinned at 57454.10 from 15:15 to 15:27. The market is demonstrably active over the
 * same minutes: NIFTYBEES and BANKBEES on the same feed show a dozen distinct closes and full volume.
 * It is the index aggregate that stops updating, and a re-fetch weeks later returns byte-identical
 * bars, so the freeze comes from the provider and cannot be repaired by refetch.
 *
 * The gap-heal path cannot see this by construction: `scan-candle-coverage.ts` classifies coverage by
 * bar *presence* at a minute index. A frozen bar is present, so it counts as covered.
 *
 * ## Why the volume guard alone was not enough
 *
 * `volume-semantics.ts` correctly nulls every volume-derived statistic on these bars. But the
 * non-volume families kept emitting: measured on one 2026-08-25 BANKNIFTY 1m session, 18
 * observations were detected *on* frozen bars — 16 `COMPRESSION_EXPANSION`, 1 `SWING_STRUCTURE`,
 * 1 `MULTI_CANDLE`. The compression count is not a coincidence. A flat bar is trivially "inside"
 * its predecessor, so a run of them manufactures inside-bar and double/triple-inside-bar chains out
 * of nothing. Their `volumeZscore` was correctly null while `rangeAtr` and `rangeBps` looked
 * entirely ordinary, because those measure the pattern span back to genuine bars.
 *
 * So the mask has to cover price as well as volume, which is what this predicate is for.
 *
 * ## Why the test is value repetition, and NOT "zero range AND zero volume"
 *
 * This predicate was originally `!hasRange && !isUsableVolume(volume)` — a conjunction requiring both
 * signals absent. That was calibrated on 2026-08-25, when the freeze carried zero volume throughout,
 * and the feed has since changed: it now stamps volume on the pinned price. Measured on NIFTY50 1m,
 * 2026-08-31, pinned at 24050.25 from 15:15 to 15:28:
 *
 *   15:16-15:19   volume 0                 conjunction refuses   (4 bars)
 *   15:20         volume 125,958,451       conjunction ADMITS
 *   15:21-15:28   volume 2.8M .. 5.3M      conjunction ADMITS    (8 bars)
 *
 * Four of thirteen frozen bars refused, nine admitted — and the admitted ones were observed. Rows
 * recorded on a zero-range bar in `pattern_observations_v2` include a NIFTY50 `HEAD_AND_SHOULDERS`
 * at 15:20 carrying `volumeZscore` 4.23 on a bar with no price range at all.
 *
 * The conjunction is not mis-tuned, it is structurally wrong for an index. Price and volume arrive
 * from different sources: index volume is a constituent aggregate (measured correlation 0.877 with
 * summed constituent cash volume, and no expiry-day spike — see `volume-semantics.ts`). Constituents
 * keep trading, and the counter keeps accumulating, while the index price aggregate is frozen. Volume
 * can therefore *never* corroborate PRICE freshness on an index. The comment this replaces defended
 * the conjunction with "a real bar that printed one price on real trades" — true of a single stock,
 * impossible for an index reporting 126M of volume at exactly one price with zero range.
 *
 * The replacement is volume-blind: a zero-range bar whose four OHLC values equal those of its
 * time-contiguous predecessor is republication, not a print. That rule is
 * `market-data/domain/tape-liveness.ts`, calibrated on 21 days of both indices — 10,800 runs of
 * consecutive OHLC-identical 1m bars in the healthy 09:16-15:15 window with a longest run of **1**,
 * against 72 runs and a longest run of **13** inside the frozen window. It is imported rather than
 * restated here so the two consumers cannot drift apart on the next feed change.
 *
 * ## What the volume test still legitimately guards
 *
 * It is kept as the fallback, not deleted, because two other shapes need it:
 *
 * - **Volume-only dropout** (2026-07-23, 2026-03-10) — volume 0 while price keeps moving
 *   (56539.75 -> 56527.10 -> 56531.40). Never reached: price moved, so `hasRange` is true and the
 *   predicate returns early. Refusing these would discard good price structure.
 * - **A single isolated flat bar** — zero range, not identical to its predecessor. On real volume it
 *   is a genuine if dull print and is admitted; on zero volume it reports nothing at all and is still
 *   refused, exactly as before. 254 of the 279 recorded zero-range observations are this shape, which
 *   is why the fallback matters and the new rule is not simply "refuse every flat bar".
 *
 * ## Why not a clock rule
 *
 * Deliberately a per-bar signature rather than a hard-coded 15:16-15:29 window. The freeze *onset* is
 * the 15:15 bar (flat, on thin but real volume), and the lump-update minute moves between sessions —
 * 15:28 on 2026-08-25, 15:29 on 2026-08-31. A rule keyed to a clock would silently stop working the
 * day the window moved, and would miss the same freeze on any other instrument or feed. That is the
 * failure this predicate has already suffered once, in a different form.
 */

/**
 * The predecessor a value-repetition test needs, and the bar spacing that makes it contiguous.
 *
 * `intervalMs` is required alongside `previous` because contiguity is load-bearing: two OHLC-identical
 * bars that are *not* one interval apart straddle a gap or a session boundary, which is a different
 * defect with a different detector, and treating them as a frozen run would manufacture a refusal
 * across every overnight close.
 */
export interface PrecedingBar {
  /** The bar immediately before `candle` in the series, or `null` at the start of the window. */
  readonly previous: CandleLike | null;
  /** Nominal spacing of the series, e.g. `timeframeDurationMs(source.timeframe)`. */
  readonly intervalMs: number;
}

/**
 * Whether this bar reports nothing that can be observed.
 *
 * `context` is optional so that a caller with no predecessor to hand — the first bar of a window, or
 * a single-bar probe — degrades to the original single-bar test rather than silently passing the bar.
 * That fallback is strictly weaker: it cannot see a frozen bar carrying volume. Any caller that has
 * the preceding bar should supply it.
 */
export function isStaleBar(candle: CandleLike, context?: PrecedingBar): boolean {
  // Price moved, so the bar reported a real observation whatever its volume did. This is the
  // volume-only dropout, and it must survive.
  if (candle.high > candle.low) return false;

  if (context?.previous) {
    const { liveness } = assessTapeLiveness({
      bars: [context.previous, candle],
      intervalMs: context.intervalMs,
    });
    // Republication of the previous print. Volume is not consulted, and on an index it must not be.
    if (liveness === "FROZEN") return true;
  }

  // A flat bar that is not a repeat: real volume makes it a dull but genuine print, no volume makes
  // it a bar that reported nothing at all.
  return !isUsableVolume(candle.volume);
}
