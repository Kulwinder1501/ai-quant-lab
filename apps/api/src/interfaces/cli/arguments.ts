import { supportedHistoricalTimeframes, type HistoricalTimeframe } from "../../modules/market-data/domain/historical-data-provider.js";

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
