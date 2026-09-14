import { nearestStrike } from "@ai-quant-lab/pricing";
import type { OptionChainSnapshot } from "./option-chain.js";
import { selectNearestListedExpiry, type OptionExpiryCalendar } from "./option-expiry-calendar.js";

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
 */
export function selectAtmPremiumContracts(
  snapshot: OptionChainSnapshot,
  options: { strikeBand?: number; maxAgeMs?: number; now?: Date } = {},
): AtmPremiumContract[] {
  const strikeBand = options.strikeBand ?? 1;
  const maxAgeMs = options.maxAgeMs ?? 40 * 60 * 1000;
  const now = options.now ?? new Date();

  if (now.getTime() - snapshot.observedAt.getTime() > maxAgeMs) {
    return [];
  }

  const spot = snapshot.underlyingValue;
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

function inferStrikeStep(sortedStrikes: readonly number[]): number | null {
  const gaps = new Set<number>();
  for (let i = 1; i < sortedStrikes.length; i += 1) {
    const gap = sortedStrikes[i]! - sortedStrikes[i - 1]!;
    if (gap > 0) gaps.add(gap);
  }
  if (gaps.size === 0) return null;
  return Math.min(...gaps);
}
