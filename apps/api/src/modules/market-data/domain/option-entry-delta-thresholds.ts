/*
 * Lives in market-data (not paper-trading) because BOTH the entry gate and the dense premium collector
 * must read the same numbers: the collector quotes the strike the gate will choose, and the gate can
 * only fill a strike the collector quoted. They were separate constants until 2026-10-12, when the
 * 2026-10-10 change moved BANKNIFTY's gate to 0.55/0.65 while the collector kept chasing 0.75, and every
 * BANKNIFTY idea that day refused NO_FRESH_EXECUTABLE_QUOTE for a strike nobody was quoting.
 * `modules/market-data` must not depend on `modules/paper-trading`, so the shared rule sits here and
 * paper-trading re-exports it.
 */

/**
 * How deep ITM a contract must be (`minEntryDelta`) to qualify at all, and which delta the
 * ranking among qualifying contracts aims for (`targetDelta`). One shared pair of constants
 * here used to block BANKNIFTY outright: see `docs/2026-10-10-option-entry-delta-threshold-
 * review.md` for the measurement.
 *
 * NIFTY50's weekly expiry keeps time-to-expiry short, so its delta/strike slope is steep and
 * a 0.75-delta contract is essentially always available -- a live chain sampled 2026-10-09
 * carried a liquid, two-sided quote up to abs(delta) 0.974. There is no reachability problem
 * to accommodate, so NIFTY50 keeps the original, strict 0.75/0.75.
 *
 * BANKNIFTY only has a monthly expiry, so days-to-expiry is routinely 15-30 and the delta
 * curve is far shallower. Replaying the real option chain through this file's own
 * `solveContractGreeksFromChain` at every live refusal between 2026-10-05 and 2026-10-08
 * found the deepest liquid, two-sided strike topped out at 0.70-0.748 -- never once reaching
 * 0.75 -- which is why the live bot took zero BANKNIFTY trades that week. The same replay
 * against the prior (2026-09-29) monthly expiry's own chain shows this is purely a
 * days-to-expiry effect, not a permanent ceiling: measured abs(delta) at the chain's deepest
 * liquid strike rose from 0.76 at DTE~25 to 0.81 at DTE~14, 0.90 at DTE~11, and 0.92-0.96
 * inside DTE~10 -- comfortably clearing 0.75 well before expiry. So BANKNIFTY uses a lower
 * floor (0.55, with margin under the measured 0.70-0.748 far-dated ceiling) most of the time,
 * and only switches to NIFTY50's strict 0.75/0.75 once its own listed expiry is within 10
 * days, which both sampled near-expiry points (DTE 10.98 and 7.17) confirm is comfortably
 * inside the window where 0.75 is actually on offer -- rather than inventing a parallel,
 * untested "deep ITM but not 0.75" target for that stretch.
 *
 * Any other underlying falls back to BANKNIFTY's permissive pair; in practice nothing else
 * reaches this gate today (gold trades spot via `PrepareDirectEntry`, never an option strike).
 */
export function resolveOptionEntryDeltaThresholds(
  underlyingSymbol: string,
  daysToExpiry: number,
): { minEntryDelta: number; targetDelta: number } {
  if (underlyingSymbol === "NIFTY50") {
    return { minEntryDelta: 0.75, targetDelta: 0.75 };
  }
  if (underlyingSymbol === "BANKNIFTY" && daysToExpiry <= 10) {
    return { minEntryDelta: 0.75, targetDelta: 0.75 };
  }
  return { minEntryDelta: 0.55, targetDelta: 0.65 };
}
