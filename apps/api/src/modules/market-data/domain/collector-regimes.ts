/**
 * The declared vocabulary of `option_premium_ticks.collector_regime` values.
 *
 * ## Why this file exists
 *
 * The regime string used to live as a private constant inside the streamer, and the poller that
 * writes the same table did not declare one at all. Migration 078 deliberately gave the column no
 * DEFAULT, on the grounds that "a default would silently label rows from any future collector that
 * forgot to stamp, which is the failure this column exists to make visible" -- and it worked
 * exactly as intended: from 2026-08-24, roughly 6-7% of each session's ticks landed NULL, and
 * `COLLECTOR_HEALTH` reported DEGRADED with `UNEXPECTED_REGIME_CHANGE:(unstamped),...` the first
 * time it was ever able to run.
 *
 * Naming the set in one place is what stops that recurring. A writer imports its own regime from
 * here, and the health check imports the expected set from here, so a new collector cannot be added
 * without appearing in the vocabulary the check reads.
 *
 * ## Regime boundaries are set by implementation changes, never by performance
 *
 * That rule is what stops a later analysis splitting the series wherever the results look better.
 * Add a value whenever what a collector captures changes, and record the boundary.
 */

/** Pre-streamer HTTP polling. Backfilled by migration 078 for sessions before 2026-08-17. */
export const LEGACY_POLLER_V1 = "LEGACY_POLLER_V1";

/** The socket streamer before source clocks were persisted. Sessions 2026-08-17 to 2026-08-24. */
export const STREAMER_V1_RECEIPT_CLOCK_ONLY = "STREAMER_V1_RECEIPT_CLOCK_ONLY";

/** The socket streamer with exchange/vendor clocks persisted and contracts retained past band exit. */
export const STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION = "STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION";

/**
 * The once-a-minute HTTP poller that runs *alongside* the streamer as a floor under it.
 *
 * Not a successor to `LEGACY_POLLER_V1` and not a leftover. The scheduler keeps it deliberately,
 * because a socket fails by going quiet: if the stream drops, this still deposits a quote on every
 * cron tick, so the series degrades to its old resolution instead of stopping. It reads the HTTP
 * quotes endpoint, which carries no exchange clock, hence the name -- rows from this regime have a
 * receipt time only, and an analysis needing `exchange_feed_time` must exclude them rather than
 * treat their NULL clocks as missing data.
 */
export const POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY = "POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY";

/**
 * Regimes that may legitimately appear together in one session.
 *
 * The health check's premise used to be one regime per session, which stopped being true the moment
 * the poller became a concurrent floor rather than the source. Two *declared* regimes in a session is
 * now the designed steady state; what remains a finding is an undeclared one, or a historical regime
 * resurfacing, which would mean a collector was rolled back without anyone saying so.
 */
export const EXPECTED_CONCURRENT_REGIMES: readonly string[] = [
  STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
  POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
];

/** Every value this system has ever written, for validating what a session contains. */
export const KNOWN_COLLECTOR_REGIMES: readonly string[] = [
  LEGACY_POLLER_V1,
  STREAMER_V1_RECEIPT_CLOCK_ONLY,
  STREAMER_V2_SOURCE_CLOCKS_AND_RETENTION,
  POLLER_V2_FLOOR_RECEIPT_CLOCK_ONLY,
];

/** Marker the health check uses for a NULL regime. A row whose capture code declared nothing. */
export const UNSTAMPED_REGIME = "(unstamped)";

/**
 * Classifies the regimes observed in one session.
 *
 * ## Why this is not simply "is every regime in the expected set"
 *
 * That was the first attempt and it was wrong: `EXPECTED_CONCURRENT_REGIMES` describes what runs
 * *today*, but the health check evaluates arbitrary session dates. Judging a 2026-08-21 session --
 * legitimately all `STREAMER_V1_RECEIPT_CLOCK_ONLY` -- against today's set marks a perfectly healthy
 * historical session DEGRADED, which would make every audit of history noisy. An existing test
 * caught it.
 *
 * So the rule is date-agnostic, and splits the two findings that were previously conflated:
 *
 * - `unstamped` is always wrong, whatever the session. A collector wrote rows without declaring what
 *   it was, which is precisely the failure `collector_regime` refuses a DEFAULT in order to expose.
 * - `unexpectedChange` is about *plurality*: more than one declared regime in a single session means
 *   a boundary was crossed mid-session, unless the whole set is one that runs concurrently by
 *   design. A single declared regime is always fine, no matter which one or how old.
 */
export function classifySessionRegimes(observed: readonly string[]): {
  readonly declared: readonly string[];
  readonly unstamped: readonly string[];
  readonly unexpectedChange: boolean;
} {
  const unique = [...new Set(observed)].sort();
  const unstamped = unique.filter((regime) => regime === UNSTAMPED_REGIME);
  const declared = unique.filter((regime) => regime !== UNSTAMPED_REGIME);
  const concurrentByDesign = declared.length <= 1
    || declared.every((regime) => EXPECTED_CONCURRENT_REGIMES.includes(regime));
  return { declared, unstamped, unexpectedChange: !concurrentByDesign };
}
