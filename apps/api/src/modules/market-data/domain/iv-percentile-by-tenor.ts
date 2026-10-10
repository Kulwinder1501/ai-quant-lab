import { atmImpliedVolatility, type AtmQuote } from "./atm-implied-volatility.js";
import { summariseIvPercentile } from "./iv-percentile.js";

/**
 * IV percentile ranked within the SAME days-to-expiry bucket.
 *
 * The earlier percentile took the last chain snapshot of each day, whose nearest expiry rotates
 * from 0 to 8 calendar days out. ATM IV is not tenor-flat: measured on NIFTY the median ATM IV at
 * about one day to expiry was 14.5 against 8.9-11.7 at the other tenors, and five of 44 days sat
 * next to zero DTE. Ranking today's 4-DTE reading against a history full of 1-DTE readings
 * reports "cheap" or "dear" for the calendar position of the expiry, not for volatility.
 *
 * So the current reading is ranked only against history from its own bucket, and:
 *   - DTE < 1 (expiry day) is excluded from both sides. Expiry-day IV is dominated by the
 *     gamma/pin effect and the denominator `sqrt(T)` collapses; it is not comparable to anything.
 *   - A bucket with fewer than `MINIMUM_BUCKET_OBSERVATIONS` distinct days is refused, with the
 *     bucket and the count in the answer, rather than ranked.
 *
 * Both sides must come from `atmImpliedVolatility` (parity forward) so the basis matches too.
 *
 * DTE is calendar days between IST dates (see `calendarDaysToExpiry`). Buckets:
 *   DTE_1      1 day            (expiry tomorrow)
 *   DTE_2_3    2-3 days
 *   DTE_4_7    4-7 days
 *   DTE_8_PLUS 8 days or more   (monthly / far weekly)
 */

export const MINIMUM_BUCKET_OBSERVATIONS = 20;

export type IvTenorBucket = "DTE_1" | "DTE_2_3" | "DTE_4_7" | "DTE_8_PLUS";

/** The bucket for a calendar-days-to-expiry count, or null for expiry day and non-finite input. */
export function ivTenorBucket(daysToExpiry: number): IvTenorBucket | null {
  if (!Number.isFinite(daysToExpiry) || daysToExpiry < 1) return null;
  if (daysToExpiry < 2) return "DTE_1";
  if (daysToExpiry < 4) return "DTE_2_3";
  if (daysToExpiry < 8) return "DTE_4_7";
  return "DTE_8_PLUS";
}

export interface TenorImpliedVolatilityObservation {
  /** Session date, `YYYY-MM-DD`; one observation per date is kept (newest wins). */
  date: string;
  impliedVolatility: number;
  daysToExpiry: number;
}

export type TenorIvPercentileResult =
  | {
    measurable: true;
    /** 0-100, the scale `options-entry-validator`'s `ivPercentile` expects. */
    percentile: number;
    bucket: IvTenorBucket;
    currentImpliedVolatility: number;
    observedDays: number;
    lowestImpliedVolatility: number;
    highestImpliedVolatility: number;
  }
  | {
    measurable: false;
    reason: "NO_CURRENT_READING" | "EXPIRY_DAY_EXCLUDED" | "INSUFFICIENT_BUCKET_HISTORY";
    explanation: string;
    bucket: IvTenorBucket | null;
    observedDays: number;
    requiredDays: number;
  };

export function summariseTenorMatchedIvPercentile(input: {
  history: readonly TenorImpliedVolatilityObservation[];
  current: { impliedVolatility: number; daysToExpiry: number } | null;
  minimumObservations?: number;
}): TenorIvPercentileResult {
  const requiredDays = input.minimumObservations ?? MINIMUM_BUCKET_OBSERVATIONS;

  if (input.current === null
    || !Number.isFinite(input.current.impliedVolatility)
    || input.current.impliedVolatility <= 0) {
    return {
      measurable: false,
      reason: "NO_CURRENT_READING",
      explanation: "No ATM implied volatility could be solved on the parity forward for the current "
        + "chain, so there is nothing to rank against history.",
      bucket: null,
      observedDays: 0,
      requiredDays,
    };
  }

  const bucket = ivTenorBucket(input.current.daysToExpiry);
  if (bucket === null) {
    return {
      measurable: false,
      reason: "EXPIRY_DAY_EXCLUDED",
      explanation: "The current expiry is less than one calendar day away. Expiry-day IV is excluded "
        + "from the percentile base on both sides: it is not comparable with any other tenor.",
      bucket: null,
      observedDays: 0,
      requiredDays,
    };
  }

  const sameBucket = input.history.filter((entry) => ivTenorBucket(entry.daysToExpiry) === bucket);
  // Delegates the one-value-per-day collapse, non-positive filtering and strict-below ranking.
  const ranked = summariseIvPercentile({
    history: sameBucket.map((entry) => ({ date: entry.date, impliedVolatility: entry.impliedVolatility })),
    currentImpliedVolatility: input.current.impliedVolatility,
    minimumDays: requiredDays,
  });
  if (!ranked.measurable) {
    return {
      measurable: false,
      reason: "INSUFFICIENT_BUCKET_HISTORY",
      explanation: `The ${bucket} bucket has ${ranked.observedDays} distinct day(s) of history; `
        + `${requiredDays} are required. Ranking against other tenors is refused because ATM IV is `
        + "not tenor-flat. Chain history is forward-accumulating, so this resolves with time.",
      bucket,
      observedDays: ranked.observedDays,
      requiredDays,
    };
  }
  return {
    measurable: true,
    percentile: ranked.percentile,
    bucket,
    currentImpliedVolatility: ranked.currentImpliedVolatility,
    observedDays: ranked.observedDays,
    lowestImpliedVolatility: ranked.lowestImpliedVolatility,
    highestImpliedVolatility: ranked.highestImpliedVolatility,
  };
}

export interface DailyChainQuote extends AtmQuote {
  /** Session date (IST), `YYYY-MM-DD`. */
  date: string;
  observedAt: Date;
  expiryDate: Date;
}

/**
 * One tenor-tagged ATM IV per session date, from that date's last snapshot, each solved by the
 * same `atmImpliedVolatility` (parity forward) the live reading uses. Days whose parity forward
 * or ATM IV cannot be solved are skipped, not approximated.
 */
export function buildTenorIvHistory(quotes: readonly DailyChainQuote[]): TenorImpliedVolatilityObservation[] {
  const byDate = new Map<string, DailyChainQuote[]>();
  for (const quote of quotes) byDate.set(quote.date, [...(byDate.get(quote.date) ?? []), quote]);
  const history: TenorImpliedVolatilityObservation[] = [];
  for (const [date, dayQuotes] of byDate) {
    const first = dayQuotes[0]!;
    const result = atmImpliedVolatility({
      observedAt: first.observedAt,
      expiryDate: first.expiryDate,
      quotes: dayQuotes,
    });
    if (result.measurable) {
      history.push({ date, impliedVolatility: result.impliedVolatility, daysToExpiry: result.daysToExpiry });
    }
  }
  return history;
}

/**
 * The value `options-entry-validator`'s `ivPercentile` field takes: the 0-100 percentile, or null
 * when it is not measurable (the validator then records "IV percentile unavailable" as unchecked
 * rather than passing or failing the trade).
 */
export function ivPercentileForValidator(result: TenorIvPercentileResult): number | null {
  return result.measurable ? result.percentile : null;
}
