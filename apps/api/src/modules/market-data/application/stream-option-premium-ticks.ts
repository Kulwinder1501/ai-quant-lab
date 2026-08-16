import type { AtmPremiumContract } from "../domain/atm-premium-contracts.js";
import type { OptionPremiumTickRow } from "../../../infrastructure/database/repositories/postgres-option-premium-tick-repository.js";

/**
 * One quote held in memory between flushes, with the instant it arrived.
 *
 * `observedAt` is when *this process saw it*, not a provider timestamp. The socket payload
 * carries no reliable clock, and inventing one would let a stale quote look fresh to the exit
 * evaluator — the single failure this module has to avoid.
 */
export interface BufferedTick {
  bid: number | null;
  ask: number | null;
  lastPrice: number | null;
  volume: number | null;
  observedAt: Date;
}

export interface SelectFlushableTicksInput {
  /** Contracts currently subscribed; nothing outside this set is persisted. */
  contracts: readonly AtmPremiumContract[];
  /** Latest quote per provider symbol, upper-cased. */
  buffered: ReadonlyMap<string, BufferedTick>;
  /** `observedAt.getTime()` of the last row already written, per provider symbol. */
  lastFlushedAt: ReadonlyMap<string, number>;
  /** Latest spot per underlying symbol, for the `underlying_value` column. */
  underlyingValues: ReadonlyMap<string, number>;
  provider: string;
  now: Date;
  /** A quote older than this is not written at all. */
  maximumTickAgeMs: number;
}

/**
 * Decide which buffered quotes become rows on this flush.
 *
 * Separated from the socket and the timer because the two rules that matter are both pure, and
 * both are rules about *not* writing:
 *
 * - **Stale quotes are dropped, never written.** A socket that dies goes quiet rather than
 *   erroring, so the last quote it delivered would otherwise be rewritten every interval and
 *   read as current. `evaluate-open-paper-trades` resolves stops against this series; feeding it
 *   a frozen bid would close positions against a price that no longer exists. Polling failed
 *   loudly (HTTP 429); a stream fails silently, and this is where that difference is paid for.
 * - **A quote is written once.** Only a tick strictly newer than the last persisted one for that
 *   symbol produces a row, so an illiquid contract that has not traded contributes nothing
 *   instead of duplicating its last print every interval. Without this the table would grow with
 *   the flush cadence rather than with market activity, and a quiet contract would look as
 *   actively quoted as a busy one.
 */
export function selectFlushableTicks(input: SelectFlushableTicksInput): OptionPremiumTickRow[] {
  const rows: OptionPremiumTickRow[] = [];
  for (const contract of input.contracts) {
    const key = contract.providerSymbol.toUpperCase();
    const buffered = input.buffered.get(key);
    if (buffered === undefined) continue;

    const observedAt = buffered.observedAt.getTime();
    if (input.now.getTime() - observedAt > input.maximumTickAgeMs) continue;

    const lastFlushed = input.lastFlushedAt.get(key);
    if (lastFlushed !== undefined && observedAt <= lastFlushed) continue;

    rows.push({
      underlyingSymbol: contract.underlyingSymbol,
      provider: input.provider,
      observedAt: buffered.observedAt,
      expiryDate: contract.expiryDate,
      strikePrice: contract.strikePrice,
      optionType: contract.optionType,
      providerSymbol: contract.providerSymbol,
      lastPrice: buffered.lastPrice,
      bid: buffered.bid,
      ask: buffered.ask,
      volume: buffered.volume,
      underlyingValue: input.underlyingValues.get(contract.underlyingSymbol) ?? null,
    });
  }
  return rows;
}

/**
 * Which symbols to subscribe and which to drop, given the contracts now wanted.
 *
 * Returned as a delta rather than a re-subscribe of the whole set: the ATM band moves by one
 * strike at a time, and unsubscribing everything to resubscribe almost the same list would leave
 * a gap in the series for contracts that never stopped being wanted — including, at the worst
 * possible moment, one an open position is being resolved against.
 */
export function resolveSubscriptionDelta(
  current: ReadonlySet<string>,
  wanted: readonly string[],
): { subscribe: string[]; unsubscribe: string[] } {
  const wantedSet = new Set(wanted.map((symbol) => symbol.toUpperCase()));
  return {
    subscribe: [...wantedSet].filter((symbol) => !current.has(symbol)),
    unsubscribe: [...current].filter((symbol) => !wantedSet.has(symbol)),
  };
}
