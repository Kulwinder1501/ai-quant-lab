import {
  assertSnapshotStorable,
  expiriesOf,
  putCallRatios,
  summariseLiquidity,
  type OptionChainSnapshot,
} from "../domain/option-chain.js";
import {
  assertCalendarStorable,
  selectNearestListedExpiry,
  type OptionExpiryCalendar,
} from "../domain/option-expiry-calendar.js";

/**
 * Mirrors `MINIMUM_DAYS_TO_EXPIRY` in `prepare-option-entry.ts`.
 *
 * Declared here rather than imported to keep market-data collection from depending on
 * paper-trading. `ingest-option-chain.test.ts` asserts the two stay equal, so a change to the
 * trading floor cannot silently stop the data that serves it from being collected.
 */
export const MINIMUM_TRADABLE_DAYS_TO_EXPIRY = 2;

export interface OptionChainSource {
  fetchChain(
    input: { underlyingSymbol: string; strikeCount?: number; expiryToken?: string | null },
  ): Promise<OptionChainSnapshot>;
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
  /**
   * Secondary books stored because the trading path would roll to them.
   *
   * Empty on an ordinary day, when the front expiry is itself tradable. Reported rather than
   * silent so "the bot has a quotable contract" is observable without reading the tick table.
   */
  tradableExpiries: Array<{
    underlyingSymbol: string; expiryDate: string; contracts: number; inserted: number;
  }>;
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

  /**
   * Also stores the expiry the trading path will actually choose.
   *
   * One chain request returns the front expiry's book, and that was the only one stored. But
   * `PrepareOptionEntry` will not trade a contract inside `MINIMUM_DAYS_TO_EXPIRY`, so within two
   * days of expiry it rolls to the next listed one -- and nothing was collecting that contract.
   * Measured 2026-08-24/25: 186 of 189 candidates were refused `NO_FRESH_EXECUTABLE_QUOTE` while
   * the front expiry was quoted continuously. The bot was asking for a book nobody was fetching.
   *
   * The front expiry is still fetched first and stored unchanged. D2's frozen protocol prices the
   * *nearest* expiry, so that series must not move; this only adds a second one beside it.
   */
  async execute(input: {
    underlyingSymbols: readonly string[];
    strikeCount?: number;
    costBudgetPercent?: number;
    /** Evaluation instant for the roll rule. Injected so the behaviour is testable. */
    now?: Date;
    /** Set false to restore front-expiry-only collection. */
    includeTradableExpiry?: boolean;
  }): Promise<IngestOptionChainResult> {
    if (input.underlyingSymbols.length === 0) {
      throw new Error("At least one underlying symbol is required.");
    }

    const now = input.now ?? new Date();
    const chains: IngestedChain[] = [];
    const failures: Array<{ underlyingSymbol: string; reason: string }> = [];
    const tradableExpiries: Array<{
      underlyingSymbol: string; expiryDate: string; contracts: number; inserted: number;
    }> = [];

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

        /*
         * Fetch the tradable expiry too, when it is not the one just stored.
         *
         * `selectNearestListedExpiry` is the same selector `PrepareOptionEntry` uses, so the two
         * agree by construction rather than by coincidence. If it ever diverges again, it diverges
         * in one place.
         *
         * Failure here is deliberately non-fatal: the front expiry is already saved, and losing the
         * secondary book must not cost the primary observation or fail the run.
         */
        if (input.includeTradableExpiry !== false) {
          const tradable = selectNearestListedExpiry(calendar, now, MINIMUM_TRADABLE_DAYS_TO_EXPIRY);
          const frontKey = expiriesOf(snapshot)[0]?.expiryDate.toISOString().slice(0, 10) ?? null;
          const tradableKey = tradable.usable ? tradable.expiryDate.toISOString().slice(0, 10) : null;
          const token = tradable.usable
            ? snapshot.listedExpiries.find(
              (entry) => entry.expiryDate.toISOString().slice(0, 10) === tradableKey,
            )?.providerExpiryToken ?? null
            : null;
          if (tradableKey !== null && tradableKey !== frontKey && token !== null) {
            try {
              const rolled = await this.source.fetchChain({
                underlyingSymbol,
                strikeCount: input.strikeCount,
                expiryToken: token,
              });
              assertSnapshotStorable(rolled);
              const savedRolled = await this.store.saveSnapshot(rolled);
              tradableExpiries.push({
                underlyingSymbol,
                expiryDate: tradableKey,
                contracts: rolled.quotes.length,
                inserted: savedRolled.inserted,
              });
            } catch (error) {
              failures.push({
                underlyingSymbol: `${underlyingSymbol} (tradable expiry ${tradableKey})`,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }

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

    return { chains, failures, tradableExpiries };
  }
}
