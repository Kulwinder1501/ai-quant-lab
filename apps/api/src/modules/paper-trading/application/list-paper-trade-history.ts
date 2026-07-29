import {
  summarizePaperTradeHistory,
  type ListPaperTradeHistoryInput,
  type PaperTradeHistoryQueryRepository,
  type PaperTradeHistoryRecord,
  type PaperTradeHistorySummary,
  type TradeOutcomeFilter,
} from "../domain/paper-trade-history.js";
import type { PaperTradeExitReason, PaperTradeStatus } from "../domain/paper-trading.js";
import type { TradeSide } from "../../strategy-engine/domain/strategy.js";

export const defaultTradeHistoryLimit = 100;
export const maximumTradeHistoryLimit = 500;

/** Raised for a client query that cannot be safely interpreted as a read-only filter. */
export class InvalidTradeHistoryQueryError extends Error {}

const statuses: readonly PaperTradeStatus[] = ["OPEN", "CLOSED", "CANCELLED"];
const sides: readonly TradeSide[] = ["LONG", "SHORT"];
const exitReasons: readonly PaperTradeExitReason[] = ["STOP_LOSS", "TARGET", "MANUAL", "CANCELLED"];
const outcomes: readonly TradeOutcomeFilter[] = ["WIN", "LOSS", "BREAK_EVEN"];

function normalizeOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new InvalidTradeHistoryQueryError(`${field} must not be blank.`);
  }
  return normalized;
}

function requireMember<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  field: string,
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new InvalidTradeHistoryQueryError(`${field} must be one of ${allowed.join(", ")}.`);
  }
  return value as T;
}

function requireTimestamp(value: Date | undefined, field: string): Date | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Number.isNaN(value.getTime())) {
    throw new InvalidTradeHistoryQueryError(`${field} must be a valid timestamp.`);
  }
  return value;
}

/**
 * Reads the local simulated-trade ledger. This use case only queries stored
 * paper activity: it cannot open, close, evaluate, or cancel a trade, and it has
 * no path to a broker.
 */
export class ListPaperTradeHistory {
  constructor(private readonly repository: PaperTradeHistoryQueryRepository) {}

  async execute(input: Partial<ListPaperTradeHistoryInput> = {}): Promise<{
    records: PaperTradeHistoryRecord[];
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

    const query: ListPaperTradeHistoryInput = {
      accountId: normalizeOptionalText(input.accountId, "accountId"),
      instrumentSymbol: normalizeOptionalText(input.instrumentSymbol, "instrument")?.toUpperCase(),
      status: requireMember(input.status, statuses, "status"),
      side: requireMember(input.side, sides, "side"),
      exitReason: requireMember(input.exitReason, exitReasons, "exitReason"),
      outcome: requireMember(input.outcome, outcomes, "outcome"),
      openedFrom,
      openedTo,
      // One extra row reveals whether the ledger was cut short, so the UI can say
      // so instead of silently presenting a partial history as complete.
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
