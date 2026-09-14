/**
 * Normalises the traded-volume field on a live quote, keeping what cannot be trusted separately.
 *
 * ## What went wrong
 *
 * On 2026-08-18 the scheduler entered a crash loop. `vol_traded_today` for an expiry-day ATM NIFTY
 * option arrived **negative** -- values from -1.85e9 to -1.99e9 -- and `option_premium_ticks` has a
 * `CHECK (volume IS NULL OR volume >= 0)`, correctly. The rejection was an unhandled promise
 * rejection, so the process died, restarted, and hit the same tick again: 25 restarts, and every
 * scheduled job stopped claiming for the rest of the session.
 *
 * The cause is a counter overflowing a signed 32-bit field somewhere inside the provider's protocol.
 * The evidence is arithmetical: the largest volume stored that day was 2,147,470,650, which is 12,997
 * below the int32 maximum of 2,147,483,647, and adding 2^32 to each rejected value gives 2.30e9-2.44e9
 * -- a counter that crossed the ceiling and kept accumulating. Our own column is BIGINT, so nothing
 * here truncated it; the value was already wrapped on arrival.
 *
 * ## Why this stores null rather than unwrapping
 *
 * Adding 2^32 would probably recover the true figure. "Probably" is the problem. It rests on an
 * inference about a third party's field width that cannot be verified from inside this system, and a
 * derived number written into a research table is indistinguishable from a measured one afterwards.
 * This codebase has paid for that mistake more than once -- fabricated indicator values, hash-noise
 * embeddings sold as semantics, a phantom option contract that overstated returns by 176 points.
 *
 * Nothing reads this volume. No exit, valuation, or strategy consults it; the option exit path uses
 * the bid series. So unwrapping buys nothing today and risks a fabricated quantity later.
 *
 * `rejectedRaw` keeps the observation instead of discarding it. If the provider's field width is ever
 * confirmed, `volume = volume_raw + 2^32` is a one-line backfill -- and until then the record says
 * "the feed reported this, and we did not believe it", which is the honest state.
 */

export interface NormalisedTradedVolume {
  /** Trustworthy cumulative volume, or null when the reported figure cannot be one. */
  readonly volume: number | null;
  /** The reported figure, kept only when it was rejected. Null when nothing was wrong. */
  readonly rejectedRaw: number | null;
}

const TRUSTED: NormalisedTradedVolume = { volume: null, rejectedRaw: null };

export function normaliseTradedVolume(raw: number | null | undefined): NormalisedTradedVolume {
  if (raw === null || raw === undefined) return TRUSTED;
  // Not a number at all: nothing to keep, and nothing to report as rejected either, since a NaN is
  // not an observation of anything.
  if (!Number.isFinite(raw)) return TRUSTED;
  // A cumulative traded volume cannot run backwards. This is the wrapped-counter case.
  if (raw < 0) return { volume: null, rejectedRaw: raw };
  // A fractional contract count is not a quantity, and the column is BIGINT so it could not be
  // stored as reported anyway. Rejected rather than rounded: rounding would invent precision.
  if (!Number.isInteger(raw)) return { volume: null, rejectedRaw: raw };
  return { volume: raw, rejectedRaw: null };
}
