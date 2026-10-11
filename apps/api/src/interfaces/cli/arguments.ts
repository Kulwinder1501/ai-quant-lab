import { supportedHistoricalTimeframes, type HistoricalTimeframe } from "../../modules/market-data/domain/historical-data-provider.js";
import { instrumentExchanges, type Instrument } from "../../modules/market-data/domain/instrument.js";

/**
 * Every CLI that addresses a stored instrument must accept every exchange the `Instrument` type
 * (and the database) supports. `calculate-technical-indicators` kept its own copy of this list
 * and fell behind when OANDA was added: the scheduler's XAU_CANDLE_COLLECTION job passes
 * `--exchange OANDA`, the CLI rejected it with exit code 1, and because the job runs its steps in
 * sequence that one rejection stopped the DXY component collection after it too (observed
 * 2026-10-10: 8 failures in 24 hours). One shared list cannot drift per-script.
 */
export function parseInstrumentExchange(value: string): Instrument["exchange"] {
  const upper = value.trim().toUpperCase();
  if ((instrumentExchanges as readonly string[]).includes(upper)) {
    return upper as Instrument["exchange"];
  }
  throw new Error(`Unsupported --exchange "${value}". Use ${instrumentExchanges.join(", ")}.`);
}

export function getOption(argumentsList: string[], name: string): string | undefined {
  const index = argumentsList.indexOf(`--${name}`);
  if (index >= 0) {
    return argumentsList[index + 1];
  }
  const prefix = `--${name}=`;
  return argumentsList.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

export function requireOption(argumentsList: string[], name: string): string {
  const value = getOption(argumentsList, name)?.trim();
  if (!value) {
    throw new Error(`Missing required option --${name}.`);
  }
  return value;
}

export function parseHistoricalTimeframe(value: string): HistoricalTimeframe {
  if (!(supportedHistoricalTimeframes as readonly string[]).includes(value)) {
    throw new Error(`Unsupported timeframe "${value}". Use: ${supportedHistoricalTimeframes.join(", ")}.`);
  }
  return value as HistoricalTimeframe;
}

export function parseDateOption(value: string, isEnd: boolean): Date {
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${isEnd ? "23:59:59.999" : "00:00:00.000"}Z`
    : value;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date "${value}". Use YYYY-MM-DD or an ISO-8601 timestamp.`);
  }
  return parsed;
}
