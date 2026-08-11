import { quoteLabSymbols } from "../../../infrastructure/market-data/yahoo-quote-client.js";
import {
  computeDriverTapeMetrics,
  type DriverTapeMetrics,
} from "../domain/driver-tape.js";
import {
  estimateContributionPts,
  resolveIndexDriverUniverse,
  type IndexDriverUniverse,
} from "../domain/nifty50-driver-weights.js";

export interface IndexDriverRow {
  symbol: string;
  name: string;
  weightPct: number;
  dayPct: number;
  last: number | null;
  estPts: number;
}

export interface IndexDriverTape {
  index: string;
  label: string;
  indexLevel: number | null;
  indexDayPct: number | null;
  estNetPts: number;
  asOf: string;
  rosterCount: number;
  drivers: IndexDriverRow[];
  tape: DriverTapeMetrics | null;
  disclaimer: string;
}

const DISCLAIMER =
  "Est. points = weight% × day% × index / 10000. Weights are approximate (not live exchange free-float) — close to contribution, not exchange-official. Breadth/concentration soft-filter the agent; they are not ML features.";

/**
 * Live Yahoo-backed driver contributions + tape metrics for one supported index.
 * Returns null when the symbol has no driver universe (e.g. Hang Seng).
 */
export async function loadIndexDriverTape(
  indexKey: string,
): Promise<IndexDriverTape | null> {
  const universe = resolveIndexDriverUniverse(indexKey);
  if (!universe) return null;
  return buildIndexDriverTape(universe);
}

async function buildIndexDriverTape(
  universe: IndexDriverUniverse,
): Promise<IndexDriverTape> {
  const quoteBySymbol = await quoteLabSymbols([
    universe.yahooIndexSymbol,
    ...universe.drivers.map((row) => row.symbol),
  ]);

  const indexQuote = quoteBySymbol.get(universe.yahooIndexSymbol) ?? null;
  const indexLevel = indexQuote?.regularMarketPrice ?? null;
  const indexDayPct = indexQuote?.regularMarketChangePercent ?? null;

  const drivers = universe.drivers
    .map((row) => {
      const quote = quoteBySymbol.get(row.symbol) ?? null;
      const dayPct = quote?.regularMarketChangePercent ?? null;
      const last = quote?.regularMarketPrice ?? null;
      const estPts =
        dayPct != null && indexLevel != null
          ? estimateContributionPts(row.weightPct, dayPct, indexLevel)
          : null;
      if (dayPct == null || estPts == null) return null;
      return {
        symbol: row.symbol,
        name: row.name,
        weightPct: row.weightPct,
        dayPct,
        last,
        estPts,
      };
    })
    .filter((row): row is IndexDriverRow => row !== null);

  drivers.sort((a, b) => Math.abs(b.estPts) - Math.abs(a.estPts));

  const estNetPts = drivers.reduce((sum, row) => sum + row.estPts, 0);
  const tape = computeDriverTapeMetrics(drivers, universe.drivers.length);

  return {
    index: universe.key,
    label: universe.label,
    indexLevel,
    indexDayPct,
    estNetPts,
    asOf: new Date().toISOString(),
    rosterCount: universe.drivers.length,
    drivers,
    tape,
    disclaimer: DISCLAIMER,
  };
}
