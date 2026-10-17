import type { CorporateActionInput } from "../infrastructure/repositories/postgres-equity-corporate-action-repository.js";
import type { PriceBarInput } from "../infrastructure/repositories/postgres-equity-price-bar-repository.js";
import type { SecondaryFactInput } from "../infrastructure/repositories/postgres-equity-secondary-fact-repository.js";
import type { RawRecord } from "../domain/types.js";

export function formatIstDate(timestampSec: number): string {
  return new Date(timestampSec * 1000).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

export interface ParsedChartData {
  priceBars: PriceBarInput[];
  corporateActions: CorporateActionInput[];
  warnings: string[];
  meta: {
    symbol?: string;
    currency?: string;
    regularMarketPrice?: number;
    regularMarketTime?: number;
    chartPreviousClose?: number;
    exchangeName?: string;
    longName?: string;
    shortName?: string;
  };
}

/**
 * Pure parser for Yahoo chart raw response.
 * Hard rule (Section 2 & Gate S5):
 * Extracts raw close only; adjclose is NEVER parsed or stored.
 */
export function parseChartRawRecord(rawRecord: RawRecord, stockId: string): ParsedChartData {
  const body = rawRecord.body as any;
  const result = body?.chart?.result?.[0];

  if (!result) {
    return {
      priceBars: [],
      corporateActions: [],
      warnings: [],
      meta: {},
    };
  }

  const meta = result.meta ?? {};
  const granularity = meta.dataGranularity;

  // Hard rule (Gate S1/S2): Reject responses that are not daily bars (e.g. Yahoo's silent fallback to 1mo)
  if (granularity && granularity !== "1d") {
    throw new Error(
      `Invalid dataGranularity '${granularity}' in chart response. Expected '1d' daily bars.`,
    );
  }

  const timestamps: number[] = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};

  const opens: (number | null)[] = quote.open ?? [];
  const highs: (number | null)[] = quote.high ?? [];
  const lows: (number | null)[] = quote.low ?? [];
  const closes: (number | null)[] = quote.close ?? []; // Raw close
  const volumes: (number | null)[] = quote.volume ?? [];

  const priceBars: PriceBarInput[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < timestamps.length; i++) {
    const ts = timestamps[i];
    const c = closes[i];
    const o = opens[i] ?? c;
    const h = highs[i] ?? c;
    const l = lows[i] ?? c;
    const v = volumes[i] ?? 0;

    // Filter out null/invalid entries (can occur on halt or non-trading slots) and record as warnings (Condition 3)
    if (ts === null || ts === undefined) {
      warnings.push(`Skipped bar at index ${i}: null timestamp.`);
      continue;
    }

    if (c === null || c === undefined) {
      const dateStr = formatIstDate(ts);
      warnings.push(`Skipped bar at index ${i} (${dateStr}, timestamp ${ts}): missing close price.`);
      continue;
    }

    priceBars.push({
      stockId,
      barDate: formatIstDate(ts),
      open: Number(o),
      high: Number(h),
      low: Number(l),
      close: Number(c),
      volume: Math.round(Number(v)),
      source: "YAHOO",
      rawRecordId: rawRecord.id,
    });
  }

  const corporateActions: CorporateActionInput[] = [];
  const events = result.events ?? {};

  // Dividends
  if (events.dividends && typeof events.dividends === "object") {
    for (const divKey of Object.keys(events.dividends)) {
      const div = events.dividends[divKey];
      if (div?.amount !== undefined && div?.date) {
        corporateActions.push({
          stockId,
          exDate: formatIstDate(div.date),
          kind: "DIVIDEND",
          value: Number(div.amount),
          source: "YAHOO",
          rawRecordId: rawRecord.id,
        });
      }
    }
  }

  // Splits
  if (events.splits && typeof events.splits === "object") {
    for (const splitKey of Object.keys(events.splits)) {
      const split = events.splits[splitKey];
      if (split?.date && split.numerator && split.denominator) {
        const ratio = split.numerator / split.denominator;
        corporateActions.push({
          stockId,
          exDate: formatIstDate(split.date),
          kind: "SPLIT",
          value: Number(ratio),
          source: "YAHOO",
          rawRecordId: rawRecord.id,
        });
      }
    }
  }

  return {
    priceBars,
    corporateActions,
    warnings,
    meta: {
      symbol: meta.symbol,
      currency: meta.currency,
      regularMarketPrice: meta.regularMarketPrice,
      regularMarketTime: meta.regularMarketTime,
      chartPreviousClose: meta.chartPreviousClose,
      exchangeName: meta.exchangeName,
      longName: meta.longName,
      shortName: meta.shortName,
    },
  };
}

/**
 * Pure parser for Yahoo fundamentals-timeseries raw response.
 */
export function parseFundamentalsRawRecord(
  rawRecord: RawRecord,
  stockId: string,
): SecondaryFactInput[] {
  const body = rawRecord.body as any;
  const results = body?.timeseries?.result ?? [];
  const facts: SecondaryFactInput[] = [];

  for (const itemObj of results) {
    const itemTypes = itemObj.meta?.type ?? [];
    for (const itemType of itemTypes) {
      const seriesArray = itemObj[itemType];
      if (!Array.isArray(seriesArray)) continue;

      const periodType = itemType.toLowerCase().startsWith("quarterly") ? "QUARTERLY" : "ANNUAL";

      for (const entry of seriesArray) {
        if (!entry.asOfDate || entry.reportedValue?.raw === undefined) continue;

        facts.push({
          stockId,
          item: itemType,
          periodType,
          periodEnd: entry.asOfDate,
          value: Number(entry.reportedValue.raw),
          currency: entry.currencyCode ?? "INR",
          basis: "UNKNOWN", // Yahoo does not specify consolidated vs standalone (Section 4)
          rawRecordId: rawRecord.id,
        });
      }
    }
  }

  return facts;
}
