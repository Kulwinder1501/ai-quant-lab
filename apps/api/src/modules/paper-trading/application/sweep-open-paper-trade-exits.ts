import type { EvaluateOpenPaperTrades } from "./evaluate-open-paper-trades.js";

export interface OpenTradeAccountReader {
  /** Accounts currently holding at least one open trade. */
  listAccountIdsWithOpenTrades(): Promise<string[]>;
}

export interface SweepOpenPaperTradeExitsResult {
  accountsSwept: number;
  tradesClosed: number;
  closedTradeIds: string[];
  failures: { tradeId: string; message: string }[];
  /** True when a sweep was already running and this call returned without doing work. */
  skippedBecauseBusy: boolean;
}

const IDLE_RESULT: SweepOpenPaperTradeExitsResult = {
  accountsSwept: 0,
  tradesClosed: 0,
  closedTradeIds: [],
  failures: [],
  skippedBecauseBusy: false,
};

/**
 * Closes open positions whose barrier the tick series already shows crossed.
 *
 * Exists so exit evaluation can hang off the tick writer rather than a cron. The evaluator it
 * wraps rescans each position from `openedAt` and books an exit at the tick that crossed the
 * barrier, so calling it more often does not change any fill -- it only shortens the window in
 * which a position that has already hit its stop is still carried as open. On a five-minute bot
 * cycle that window was up to five minutes; driven by the flush loop it is a few seconds.
 *
 * Single-flight by construction. Evaluation reads the whole life of every open position, so a
 * slow pass under a fast tick loop would otherwise pile up passes that each redo the same scan,
 * and the second one only ever loses the race: `close()` takes `FOR UPDATE` and throws on an
 * already-closed row, which would turn a harmless overlap into a stream of reported failures.
 */
export class SweepOpenPaperTradeExits {
  private inFlight: Promise<SweepOpenPaperTradeExitsResult> | null = null;

  constructor(
    private readonly accounts: OpenTradeAccountReader,
    private readonly evaluate: Pick<EvaluateOpenPaperTrades, "execute">,
  ) {}

  async execute(asOf: Date = new Date()): Promise<SweepOpenPaperTradeExitsResult> {
    if (this.inFlight) return { ...IDLE_RESULT, skippedBecauseBusy: true };
    this.inFlight = this.sweep(asOf).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  private async sweep(asOf: Date): Promise<SweepOpenPaperTradeExitsResult> {
    const accountIds = await this.accounts.listAccountIdsWithOpenTrades();
    const closedTradeIds: string[] = [];
    const failures: { tradeId: string; message: string }[] = [];

    for (const accountId of accountIds) {
      // Per account rather than all-or-nothing: one account with an unevaluable position must
      // not leave every other account's stops unenforced for the rest of the session.
      try {
        const result = await this.evaluate.execute({ accountId, asOf });
        closedTradeIds.push(...result.closedTradeIds);
        failures.push(...result.evaluationFailures);
      } catch (error) {
        failures.push({
          tradeId: `account:${accountId}`,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      accountsSwept: accountIds.length,
      tradesClosed: closedTradeIds.length,
      closedTradeIds,
      failures,
      skippedBecauseBusy: false,
    };
  }
}
