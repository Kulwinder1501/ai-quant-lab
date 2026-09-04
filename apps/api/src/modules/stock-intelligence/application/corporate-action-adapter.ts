import type { CorporateActionType } from "../domain/canonical.js";
import { utcDateKey } from "../domain/returns.js";
import { assertAvailableAtCutoff } from "../domain/timestamps.js";

export interface YahooChartEvents {
  readonly splits?: unknown;
  readonly dividends?: unknown;
}

export interface DiscoveredCorporateAction {
  readonly actionType: CorporateActionType;
  readonly exDate: string;
  readonly publishedAt: Date;
  readonly effectiveAt: Date;
  readonly availableAt: Date;
  readonly details: Record<string, unknown>;
}

export interface CorporateActionAdapter {
  fetchActions(input: {
    instrumentId: string;
    symbol: string;
    from: Date;
    to: Date;
    dataCutoff: Date;
  }): Promise<readonly DiscoveredCorporateAction[]>;
}

function asEventRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    return value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  }
  if (value && typeof value === "object") {
    return Object.values(value).filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null);
  }
  return [];
}

function eventDate(row: Record<string, unknown>): Date | null {
  const raw = row.date ?? row.exDate;
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
  if (typeof raw === "string" || typeof raw === "number") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

/**
 * Maps Yahoo chart `events` onto canonical actions. Yahoo does not distinguish a
 * bonus issue from a split, so bonuses arrive as `SPLIT` with the share ratio.
 * `available_at` is the ex-date: Yahoo does not give announcement time, so these
 * rows cannot be used as prediction-time features, only as return adjustments.
 */
export function corporateActionsFromYahooEvents(
  events: YahooChartEvents | null | undefined,
  dataCutoff: Date,
): DiscoveredCorporateAction[] {
  const discovered: DiscoveredCorporateAction[] = [];

  for (const row of asEventRows(events?.splits)) {
    const date = eventDate(row);
    if (!date) continue;
    const availableAt = date;
    if (availableAt.getTime() > dataCutoff.getTime()) continue;
    assertAvailableAtCutoff(availableAt, dataCutoff, `yahoo-split:${utcDateKey(date)}`);
    discovered.push({
      actionType: "SPLIT",
      exDate: utcDateKey(date),
      publishedAt: date,
      effectiveAt: date,
      availableAt,
      details: {
        source: "yahoo",
        numerator: row.numerator ?? row.splitRatio,
        denominator: row.denominator ?? 1,
        yahooReportsBonusAsSplit: true,
      },
    });
  }

  for (const row of asEventRows(events?.dividends)) {
    const date = eventDate(row);
    if (!date) continue;
    const availableAt = date;
    if (availableAt.getTime() > dataCutoff.getTime()) continue;
    assertAvailableAtCutoff(availableAt, dataCutoff, `yahoo-dividend:${utcDateKey(date)}`);
    discovered.push({
      actionType: "DIVIDEND",
      exDate: utcDateKey(date),
      publishedAt: date,
      effectiveAt: date,
      availableAt,
      details: {
        source: "yahoo",
        amountPerShare: row.amount ?? row.dividend,
      },
    });
  }

  return discovered;
}
