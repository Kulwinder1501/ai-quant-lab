import { summarizePaperTradeHistory, type ListPaperTradeHistoryInput, type PaperTradeHistorySummary } from "../domain/paper-trade-history.js";
import type { JournalQueryRepository, JournalTradeRecord } from "../domain/journal.js";
import {
  InvalidTradeHistoryQueryError,
  defaultTradeHistoryLimit,
  maximumTradeHistoryLimit,
  normalizeOptionalText,
  requireMember,
  requireTimestamp,
  tradeHistoryExitReasons,
  tradeHistoryOutcomes,
  tradeHistorySides,
  tradeHistoryStatuses,
} from "./list-paper-trade-history.js";

/**
 * Reads the Journal: the same simulated-trade ledger Trade History reads, plus each trade's
 * entry-time reasoning and (once reviewed) its measured review. Query validation is the exact
 * `ListPaperTradeHistory` logic reused via its exported helpers, not a second copy of it --
 * the two views must reject the same malformed query the same way.
 */
export class ListJournalTrades {
  constructor(private readonly repository: JournalQueryRepository) {}

  async execute(input: Partial<ListPaperTradeHistoryInput> = {}): Promise<{
    records: JournalTradeRecord[];
    summary: PaperTradeHistorySummary;
    limit: number;
    truncated: boolean;
    accounts: Array<{ id: string; name: string }>;
  }> {
    const limit = input.limit ?? defaultTradeHistoryLimit;
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumTradeHistoryLimit) {
      throw new InvalidTradeHistoryQueryError(
        `limit must be an integer between 1 and ${maximumTradeHistoryLimit}.`,
      );
    }

    const openedFrom = requireTimestamp(input.openedFrom, "openedFrom");
    const openedTo = requireTimestamp(input.openedTo, "openedTo");
    if (openedFrom && openedTo && openedFrom > openedTo) {
      throw new InvalidTradeHistoryQueryError("openedFrom must not be later than openedTo.");
    }
    const activityFrom = requireTimestamp(input.activityFrom, "activityFrom");
    const activityToExclusive = requireTimestamp(input.activityToExclusive, "activityToExclusive");
    if ((activityFrom === undefined) !== (activityToExclusive === undefined)) {
      throw new InvalidTradeHistoryQueryError("activityFrom and activityToExclusive must be supplied together.");
    }
    if (activityFrom && activityToExclusive && activityFrom >= activityToExclusive) {
      throw new InvalidTradeHistoryQueryError("activityFrom must be earlier than activityToExclusive.");
    }

    const query: ListPaperTradeHistoryInput = {
      accountId: normalizeOptionalText(input.accountId, "accountId"),
      instrumentSymbol: normalizeOptionalText(input.instrumentSymbol, "instrument")?.toUpperCase(),
      status: requireMember(input.status, tradeHistoryStatuses, "status"),
      side: requireMember(input.side, tradeHistorySides, "side"),
      exitReason: requireMember(input.exitReason, tradeHistoryExitReasons, "exitReason"),
      outcome: requireMember(input.outcome, tradeHistoryOutcomes, "outcome"),
      openedFrom,
      openedTo,
      activityFrom,
      activityToExclusive,
      limit: limit + 1,
    };

    const [candidates, accounts] = await Promise.all([
      this.repository.list(query),
      this.repository.listAccountNames(),
    ]);
    const records = candidates.slice(0, limit);
    return {
      records,
      summary: summarizePaperTradeHistory(records),
      limit,
      truncated: candidates.length > limit,
      accounts,
    };
  }
}
