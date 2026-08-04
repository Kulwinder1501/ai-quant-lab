import {
  assertSnapshotStorable,
  expiriesOf,
  putCallRatios,
  summariseLiquidity,
  type OptionChainSnapshot,
} from "../domain/option-chain.js";
import {
  assertCalendarStorable,
  type OptionExpiryCalendar,
} from "../domain/option-expiry-calendar.js";

export interface OptionChainSource {
  fetchChain(input: { underlyingSymbol: string; strikeCount?: number }): Promise<OptionChainSnapshot>;
}

export interface OptionChainStore {
  saveSnapshot(snapshot: OptionChainSnapshot): Promise<{ inserted: number; skipped: number }>;
  saveExpiryCalendar(calendar: OptionExpiryCalendar): Promise<{ inserted: number }>;
}

export interface IngestedChain {
  underlyingSymbol: string;
  observedAt: string;
  contracts: number;
  inserted: number;
  skipped: number;
  expiries: Array<{ expiryDate: string; expiryKind: string }>;
  /** Contracts the provider lists, which is what a requested expiry is checked against. */
  listedExpiries: Array<{ expiryDate: string; expiryKind: string }>;
  putCallOpenInterestRatio: number | null;
  medianSpreadPercent: number | null;
  /** Contracts whose spread fits the cost budget the measured edge can afford. */
  tradeableAtCostBudget: number;
}

export interface IngestOptionChainResult {
  chains: IngestedChain[];
  failures: Array<{ underlyingSymbol: string; reason: string }>;
}

/**
 * Collects the current option chain for a set of underlyings.
 *
 * One underlying failing must not stop the rest: a chain is per-instrument, so an
 * unlisted or mistyped symbol is a local problem. Failures are reported rather than
 * thrown, so a partial collection is visible instead of silent.
 *
 * The derived figures returned here are for the operator's log only. Nothing derived is
 * stored: the table holds raw observations so any definition can be re-scored from
 * history rather than frozen into it.
 */
export class IngestOptionChain {
  constructor(
    private readonly source: OptionChainSource,
    private readonly store: OptionChainStore,
  ) {}

  async execute(input: {
    underlyingSymbols: readonly string[];
    strikeCount?: number;
    costBudgetPercent?: number;
  }): Promise<IngestOptionChainResult> {
    if (input.underlyingSymbols.length === 0) {
      throw new Error("At least one underlying symbol is required.");
    }

    const chains: IngestedChain[] = [];
    const failures: Array<{ underlyingSymbol: string; reason: string }> = [];

    for (const underlyingSymbol of input.underlyingSymbols) {
      try {
        const snapshot = await this.source.fetchChain({
          underlyingSymbol,
          strikeCount: input.strikeCount,
        });
        // Validated before the write, so a provider fault never reaches the raw table.
        assertSnapshotStorable(snapshot);
        const saved = await this.store.saveSnapshot(snapshot);
        // Stored even though nothing derived is: this is a raw observation of which
        // contracts exist, and it is the only thing standing between a hand-supplied
        // expiry and a contract that never traded.
        const calendar: OptionExpiryCalendar = {
          underlyingSymbol: snapshot.underlyingSymbol,
          provider: snapshot.provider,
          observedAt: snapshot.observedAt,
          expiries: snapshot.listedExpiries,
        };
        assertCalendarStorable(calendar);
        await this.store.saveExpiryCalendar(calendar);
        const ratios = putCallRatios(snapshot.quotes);
        const liquidity = summariseLiquidity(snapshot.quotes, input.costBudgetPercent);

        chains.push({
          underlyingSymbol: snapshot.underlyingSymbol,
          observedAt: snapshot.observedAt.toISOString(),
          contracts: snapshot.quotes.length,
          inserted: saved.inserted,
          skipped: saved.skipped,
          expiries: expiriesOf(snapshot).map((entry) => ({
            expiryDate: entry.expiryDate.toISOString().slice(0, 10),
            expiryKind: entry.expiryKind,
          })),
          listedExpiries: snapshot.listedExpiries.map((entry) => ({
            expiryDate: entry.expiryDate.toISOString().slice(0, 10),
            expiryKind: entry.expiryKind,
          })),
          putCallOpenInterestRatio: ratios.openInterestRatio,
          medianSpreadPercent: liquidity.medianSpreadPercent,
          tradeableAtCostBudget: liquidity.withinCostBudget,
        });
      } catch (error) {
        failures.push({
          underlyingSymbol,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { chains, failures };
  }
}
