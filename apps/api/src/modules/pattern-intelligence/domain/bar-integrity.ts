import type { CandleLike } from "./pattern-context-calculator.js";
import { isUsableVolume } from "./volume-semantics.js";

/**
 * Whether a stored bar carries any observation at all, or is a placeholder the feed emitted.
 *
 * ## The measured defect
 *
 * From 2026-08-03 the Fyers *index* feed freezes for 15:16-15:29 IST every session without
 * exception. Across that block all four OHLC values are the identical constant — 2026-08-25
 * BANKNIFTY sat pinned at 57454.10 from 15:15 to 15:27 — and volume is 0. The market is
 * demonstrably active over the same minutes: NIFTYBEES and BANKBEES on the same feed show a dozen
 * distinct closes and full volume. It is the index aggregate that stops updating, and a re-fetch
 * weeks later returns byte-identical bars, so the zeros come from the provider and cannot be
 * repaired by refetch.
 *
 * The gap-heal path cannot see this by construction: `scan-candle-coverage.ts` classifies coverage
 * by bar *presence* at a minute index and never reads `volume`. A frozen bar is present, so it
 * counts as covered.
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
 * ## Why both signals are required, not either
 *
 * The two faults in the data look identical to a `volume = 0` query and mean opposite things:
 *
 * - **Frozen bar** — zero range *and* no usable volume. Neither price nor participation was
 *   reported. Nothing about the bar is an observation.
 * - **Volume-only dropout** (2026-07-23, 2026-03-10) — volume 0 while price keeps moving
 *   (56539.75 -> 56527.10 -> 56531.40). The price series is trustworthy here; only volume is
 *   unknown, and the volume guard already handles it. Refusing the whole bar would discard good
 *   price structure.
 *
 * A zero-range bar carrying real volume is also a genuine, if dull, observation — a real bar that
 * printed one price on real trades. Requiring both signals to be absent keeps all three cases
 * distinct, and deliberately makes this predicate conservative: it refuses only bars that report
 * nothing whatsoever.
 *
 * This is intentionally a per-bar signature rather than a hard-coded 15:16-15:29 window. The
 * deterministic block is what makes the fault easy to confirm, but a rule keyed to a clock would
 * silently stop working the day the window moves, and would miss the same freeze on any other
 * instrument or feed.
 */
export function isStaleBar(candle: CandleLike): boolean {
  const hasRange = candle.high > candle.low;
  return !hasRange && !isUsableVolume(candle.volume);
}
