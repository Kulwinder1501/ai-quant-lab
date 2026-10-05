import { nearestStrike } from "@ai-quant-lab/pricing";
import type { OptionChainSnapshot } from "./option-chain.js";
import { selectNearestListedExpiry, type OptionExpiryCalendar } from "./option-expiry-calendar.js";
import { solveContractGreeksFromChain } from "./chain-greeks.js";

/**
 * Which expiries the dense premium feed must cover, as `YYYY-MM-DD` keys.
 *
 * Two, not one, and for two independent reasons:
 *
 * - **The front expiry** is what D2 prices. Its protocol is frozen on the *nearest* expiry, so this
 *   series must keep flowing whatever else changes. It is always first in the returned list.
 * - **The tradable expiry** is what `PrepareOptionEntry` will actually choose, since it refuses a
 *   contract inside `MINIMUM_DAYS_TO_EXPIRY`. Collecting only the front one is what silently stopped
 *   the paper bots on 2026-08-24: 186 of 189 candidates refused `NO_FRESH_EXECUTABLE_QUOTE` for a
 *   contract nobody was quoting, while the front book streamed continuously.
 *
 * On most days these are the same expiry and the list has one entry. They diverge for the last two
 * days of each cycle, which is exactly when the bots went quiet.
 */
export function premiumCoverageExpiries(
  calendar: OptionExpiryCalendar | null,
  now: Date,
  minimumTradableDays: number,
): string[] {
  if (calendar === null || calendar.expiries.length === 0) return [];
  const key = (value: Date): string => value.toISOString().slice(0, 10);
  const sorted = [...calendar.expiries]
    .filter((entry) => !Number.isNaN(entry.expiryDate.getTime()))
    .sort((left, right) => left.expiryDate.getTime() - right.expiryDate.getTime());

  // The front expiry is the nearest that has not already settled. An expiry whose settlement has
  // passed is not a contract anyone can quote, so it is not coverage.
  const front = sorted.find((entry) => entry.expiryDate.getTime() > now.getTime());
  const tradable = selectNearestListedExpiry(calendar, now, minimumTradableDays);

  const keys: string[] = [];
  if (front) keys.push(key(front.expiryDate));
  if (tradable.usable) {
    const tradableKey = key(tradable.expiryDate);
    if (!keys.includes(tradableKey)) keys.push(tradableKey);
  }
  return keys;
}

export interface AtmPremiumContract {
  underlyingSymbol: string;
  expiryDate: string;
  strikePrice: number;
  optionType: "CE" | "PE";
  providerSymbol: string;
}

/**
 * Picks ATM ± band contracts from one coherent chain snapshot for dense premium polls.
 *
 * Strike comes from `nearestStrike(spot, step)` inferred from the book — never a
 * price-level guess (BANKNIFTY once got non-existent 50-pt strikes that way).
 *
 * `spotOverride` lets the caller supply a spot fresher than `snapshot.underlyingValue`. The
 * snapshot backing this poll is the 15-minute full-chain job's, so at the open its own spot can be
 * up to 15 minutes stale while the dense poller itself runs once a minute -- on 43% of sessions
 * (worse on BANKNIFTY, whose 100-pt strike step is more easily outrun by an opening move) this
 * left the true ATM strike uncovered for several minutes, refusing otherwise-fillable entries with
 * `NO_FRESH_EXECUTABLE_QUOTE`. The strike *grid* still comes from the snapshot's quotes -- which
 * strikes NSE lists does not change intraday, only which one is ATM does -- so only the spot used
 * to pick among them needs to be fresher than the chain listing itself.
 */
export function selectAtmPremiumContracts(
  snapshot: OptionChainSnapshot,
  options: { strikeBand?: number; maxAgeMs?: number; now?: Date; spotOverride?: number | null } = {},
): AtmPremiumContract[] {
  const strikeBand = options.strikeBand ?? 1;
  const maxAgeMs = options.maxAgeMs ?? 40 * 60 * 1000;
  const now = options.now ?? new Date();

  if (now.getTime() - snapshot.observedAt.getTime() > maxAgeMs) {
    return [];
  }

  const override = options.spotOverride;
  const spot = override !== null && override !== undefined && Number.isFinite(override) && override > 0
    ? override
    : snapshot.underlyingValue;
  if (spot === null || !Number.isFinite(spot) || spot <= 0) {
    return [];
  }

  // Select one expiry before inferring the strike grid. Mixing weekly and monthly rows can
  // manufacture a smaller step that does not exist on the expiry being polled.
  const expiries = [...new Set(
    snapshot.quotes.map((q) => q.expiryDate.toISOString().slice(0, 10)),
  )].sort();
  if (expiries.length === 0) return [];
  const expiryDate = expiries[0]!;
  const expiryQuotes = snapshot.quotes.filter(
    (quote) => quote.expiryDate.toISOString().slice(0, 10) === expiryDate,
  );

  const strikes = [...new Set(expiryQuotes.map((q) => q.strikePrice))]
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  if (strikes.length < 2) return [];

  const step = inferStrikeStep(strikes);
  if (step === null) return [];

  const atm = nearestStrike(spot, step);
  const wanted = new Set<number>();
  for (let i = -strikeBand; i <= strikeBand; i += 1) {
    wanted.add(atm + i * step);
  }

  const selected: AtmPremiumContract[] = [];
  for (const strike of wanted) {
    for (const optionType of ["CE", "PE"] as const) {
      const quote = expiryQuotes.find(
        (q) =>
          q.strikePrice === strike
          && q.optionType === optionType
          && q.expiryDate.toISOString().slice(0, 10) === expiryDate,
      );
      if (!quote?.providerSymbol) continue;
      selected.push({
        underlyingSymbol: snapshot.underlyingSymbol,
        expiryDate,
        strikePrice: strike,
        optionType,
        providerSymbol: quote.providerSymbol,
      });
    }
  }
  return selected;
}

/**
 * Mirrors `MIN_ENTRY_DELTA` / `TARGET_DELTA` in `prepare-option-entry.ts` (both 0.75 today).
 *
 * Restated rather than imported: `modules/market-data` must not depend on `modules/paper-trading`
 * (the dependency points the other way everywhere else in this codebase -- see
 * `collect-option-premium-ticks.ts`'s own comment on `collectorRegime` for the same rule applied
 * to a different constant). If that gate's target ever moves, this must move with it; nothing
 * enforces that automatically, which is why both call sites below also accept an override.
 */
export const DEFAULT_DELTA_TARGET = 0.75;

/**
 * Picks the contract(s) `PrepareOptionEntry`'s delta-based selection is actually going to choose,
 * from the same chain snapshot the dense collector already has -- not a guessed strike-count away
 * from ATM.
 *
 * `PrepareOptionEntry` (apps/api/src/modules/paper-trading/application/prepare-option-entry.ts)
 * stopped picking the near-ATM strike on 2026-10-01 ("O1 engine and gold isolation") and started
 * picking the strike whose delta is closest to 0.75 among every strike with `abs(delta) >= 0.75` --
 * a genuine options-pricing decision, not a strike-count offset. `selectAtmPremiumContracts`'s
 * ATM±`strikeBand` window has no way to express that: band 1 covers three strikes either side of
 * spot, but a 0.75-delta BANKNIFTY call at a realistic ~22-day monthly tenor sits roughly 12-15
 * strikes away (confirmed against the live chain on 2026-10-05: BANKNIFTY spot 54,612.70, 22.1 DTE,
 * 16-18% IV -- the 0.75-delta neighbourhood was strikes 53,100-53,500, 11-15 steps below ATM).
 * That gap is why trade idea `f29afcdc-3815-4c27-a6f8-34df642d5f74` refused every two-minute tick
 * with `NO_FRESH_EXECUTABLE_QUOTE`: the contract `PrepareOptionEntry` wanted was never quoted by
 * this collector in the first place.
 *
 * A fixed wider band was considered and rejected. The distance to a 0.75-delta strike is not a
 * constant -- it scales with both time-to-expiry and implied volatility, and BANKNIFTY's
 * monthly-only calendar means the collector must cover DTE anywhere from 2 to roughly 36 days
 * (right after a roll). A sweep against this file's own Black-Scholes delta at BANKNIFTY's strikes
 * found the 0.75-delta distance ranging from 4 steps (5 DTE, 10% IV) to 19+ steps (40 DTE, 20% IV)
 * -- no single fixed band is both cheap on ordinary days and safe on the wide ones, and guessing
 * one `MAX_STRIKE_STEP`-style constant here would only be right for the DTE/IV combination it was
 * tuned against, the same mistake the deep-ITM selection itself was added to get away from.
 * Solving for the actual delta directly instead means this collector tracks whatever
 * `PrepareOptionEntry` will do without needing to be retuned when IV or the roll calendar moves --
 * and it costs only a handful of extra quotes (`2 * strikeMargin + 1` per side that clears the
 * floor), not the 25+ per side a band wide enough for the worst case would need against the Fyers
 * rate limit this collector already has a documented history of tripping (see
 * `OptionPremiumTickStreamer`'s class doc: 97 of 1,038 HTTP runs 429'd in one week).
 *
 * Returns nothing for a side where no strike in the *listed* chain reaches the delta floor at all
 * (observed live on the BANKNIFTY put side on 2026-10-05: the furthest listed strike only reached
 * delta -0.71). That is a strike-*listing*-range gap in the 15-minute chain collector, not
 * something this dense poller can fix by asking Fyers for a strike nobody listed -- and
 * `PrepareOptionEntry` would refuse that side with `NO_OPTION_ENTRY` before ever reaching the
 * freshness check this collector exists to satisfy, so there is nothing to pre-emptively quote.
 */
export function selectDeltaTargetPremiumContracts(
  snapshot: OptionChainSnapshot,
  options: {
    targetDelta?: number;
    /**
     * Strike-steps of margin kept on each side of the computed target, to absorb drift between
     * this snapshot (up to `maxAgeMs` old) and whatever chain `PrepareOptionEntry` reads for the
     * same contract at idea-evaluation time. Both read the same table on a similar cadence, so
     * day-to-day this covers rounding rather than a real gap -- it is not re-deriving the whole
     * ATM-to-target span, only guarding the one strike the chain says is the answer.
     */
    strikeMargin?: number;
    maxAgeMs?: number;
    now?: Date;
  } = {},
): AtmPremiumContract[] {
  const targetDelta = options.targetDelta ?? DEFAULT_DELTA_TARGET;
  const strikeMargin = options.strikeMargin ?? 2;
  const maxAgeMs = options.maxAgeMs ?? 40 * 60 * 1000;
  const now = options.now ?? new Date();

  if (now.getTime() - snapshot.observedAt.getTime() > maxAgeMs) return [];

  // Same expiry-isolation rule as `selectAtmPremiumContracts`: infer the strike grid from one
  // expiry only, never a mix.
  const expiries = [...new Set(
    snapshot.quotes.map((q) => q.expiryDate.toISOString().slice(0, 10)),
  )].sort();
  if (expiries.length === 0) return [];
  const expiryDate = expiries[0]!;
  const expiryQuotes = snapshot.quotes.filter(
    (quote) => quote.expiryDate.toISOString().slice(0, 10) === expiryDate,
  );

  const strikes = [...new Set(expiryQuotes.map((q) => q.strikePrice))]
    .filter((s) => Number.isFinite(s) && s > 0)
    .sort((a, b) => a - b);
  if (strikes.length < 2) return [];

  const step = inferStrikeStep(strikes);
  if (step === null) return [];

  const selected: AtmPremiumContract[] = [];
  for (const optionType of ["CE", "PE"] as const) {
    const withDelta: Array<{ strike: number; absDelta: number }> = [];
    for (const strike of strikes) {
      const greeks = solveContractGreeksFromChain({ snapshot, strikePrice: strike, optionType });
      if (greeks !== null && Number.isFinite(greeks.delta)) {
        withDelta.push({ strike, absDelta: Math.abs(greeks.delta) });
      }
    }

    // Mirror `PrepareOptionEntry`'s own eligibility floor: only a strike that already clears the
    // target delta is one it could ever pick. Nothing below the floor is a candidate.
    const eligible = withDelta.filter((d) => d.absDelta >= targetDelta);
    if (eligible.length === 0) continue;

    eligible.sort((a, b) => Math.abs(a.absDelta - targetDelta) - Math.abs(b.absDelta - targetDelta));
    const best = eligible[0]!;

    for (let i = -strikeMargin; i <= strikeMargin; i += 1) {
      const strike = best.strike + i * step;
      const quote = expiryQuotes.find(
        (q) => q.strikePrice === strike && q.optionType === optionType,
      );
      if (!quote?.providerSymbol) continue;
      selected.push({
        underlyingSymbol: snapshot.underlyingSymbol,
        expiryDate,
        strikePrice: strike,
        optionType,
        providerSymbol: quote.providerSymbol,
      });
    }
  }
  return selected;
}

function inferStrikeStep(sortedStrikes: readonly number[]): number | null {
  const gaps = new Set<number>();
  for (let i = 1; i < sortedStrikes.length; i += 1) {
    const gap = sortedStrikes[i]! - sortedStrikes[i - 1]!;
    if (gap > 0) gaps.add(gap);
  }
  if (gaps.size === 0) return null;
  return Math.min(...gaps);
}
