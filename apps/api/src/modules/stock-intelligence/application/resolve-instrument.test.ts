import { describe, expect, it } from "vitest";
import type { Instrument, InstrumentRepository, UpsertInstrumentInput } from "../../market-data/domain/instrument.js";
import { InstrumentResolveError } from "../domain/identity.js";
import { STOCK_INTELLIGENCE_ROSTER_AS_OF, stockIntelligenceEquityRoster } from "../domain/seed-roster.js";
import type { InstrumentAlias, StockIntelligenceStore } from "../domain/store.js";
import type { InstrumentExistence, UniverseMembership } from "../domain/universe.js";
import { ResolveInstrument } from "./resolve-instrument.js";
import { SeedStockIntelligenceUniverse } from "./seed-universe.js";
import { YahooMarketDataAdapter } from "./yahoo-market-data-adapter.js";
import { investorFacingBlockedReason } from "./evaluate-eligibility.js";
import type { HistoricalMarketCandle, HistoricalMarketDataProvider } from "../../market-data/domain/historical-data-provider.js";

function instrument(overrides: Partial<Instrument> = {}): Instrument {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    exchange: "NSE",
    symbol: "RELIANCE",
    displayName: "Reliance Industries",
    instrumentType: "EQUITY",
    isin: "INE002A01018",
    tickSize: "0.05",
    lotSize: 1,
    isActive: false,
    metadata: {},
    ...overrides,
  };
}

function memoryInstruments(seed: Instrument[] = []): InstrumentRepository {
  const rows = [...seed];
  return {
    upsert: async (input: UpsertInstrumentInput) => {
      const existing = rows.find((row) => row.exchange === input.exchange && row.symbol === input.symbol.trim().toUpperCase());
      if (existing) return existing;
      const created = instrument({
        id: `id-${input.symbol}`,
        exchange: input.exchange,
        symbol: input.symbol.trim().toUpperCase(),
        displayName: input.displayName,
        instrumentType: input.instrumentType,
        isActive: input.isActive ?? true,
        metadata: input.metadata ?? {},
      });
      rows.push(created);
      return created;
    },
    findById: async (id) => rows.find((row) => row.id === id) ?? null,
    findByExchangeAndSymbol: async (exchange, symbol) =>
      rows.find((row) => row.exchange === exchange && row.symbol === symbol.trim().toUpperCase()) ?? null,
    findByIsin: async (isin) => rows.filter((row) => row.isin?.toUpperCase() === isin.trim().toUpperCase()),
    listActive: async () => rows.filter((row) => row.isActive),
  };
}

function memoryStore(): StockIntelligenceStore {
  const aliases = new Map<string, string>();
  const memberships = new Map<string, UniverseMembership[]>();
  const existence: InstrumentExistence[] = [];
  return {
    findAlias: async (alias) => aliases.get(alias) ?? null,
    upsertAlias: async (alias: InstrumentAlias) => {
      aliases.set(alias.alias, alias.instrumentId);
    },
    listMemberships: async (instrumentId) => memberships.get(instrumentId) ?? [],
    upsertMembership: async (membership) => {
      const current = memberships.get(membership.instrumentId) ?? [];
      current.push(membership);
      memberships.set(membership.instrumentId, current);
    },
    findExistenceAsOf: async (instrumentId, asOf) => {
      const covering = existence
        .filter((row) => row.instrumentId === instrumentId && row.availableAt.getTime() <= asOf.getTime())
        .sort((a, b) => b.availableAt.getTime() - a.availableAt.getTime());
      return covering[0] ?? null;
    },
    listAllExistence: async () => [...existence],
    upsertExistence: async (row) => {
      existence.push(row);
    },
    insertRaw: async () => "raw",
    listRawAsOf: async () => [],
    listAllMemberships: async () => [...memberships.values()].flat(),
    insertFact: async () => "fact",
    insertFeature: async () => "feature",
    listFeaturesAsOf: async () => [],
    listFeaturesBefore: async () => [],
    insertSignal: async () => "signal",
    insertFundamentalSnapshot: async () => "fund",
    insertCorporateAction: async () => "action",
    listCorporateActionsAsOf: async () => [],
    listFactsAsOf: async () => [],
    listSignalsAsOf: async () => [],
    listSignalsBefore: async () => [],
    listFundamentalsAsOf: async () => [],
    createReplayJob: async (input) => ({
      jobId: "job-test",
      status: "RUNNING",
      jobKind: input.jobKind ?? "monthly_data_replay",
      completedPairs: [],
      remainingPairs: [...input.remainingPairs],
      lastCheckpoint: new Date("2026-09-03T00:00:00.000Z"),
      pipelineVersions: input.pipelineVersions,
      windowFrom: input.windowFrom ?? null,
      windowTo: input.windowTo ?? null,
    }),
    getReplayJob: async () => null,
    checkpointReplayJob: async () => undefined,
    insertReplayPairResult: async () => undefined,
    listReplayPairResults: async () => [],
    insertSnapshot: async () => "snap",
    listSnapshotsAsOf: async () => [],
    listSnapshotsAvailableAt: async () => [],
    insertDecayMark: async () => "mark",
    listDecayMarks: async () => [],
    listHoldings: async () => [],
    listInvestorWatchlist: async () => [],
    insertGate7Report: async () => "gate7",
    latestGate7Report: async () => null,
  };
}

describe("ResolveInstrument", () => {
  const reliance = instrument();

  it("resolves a UUID to instruments.id, never a parallel IND_EQUITY key", async () => {
    const resolver = new ResolveInstrument(memoryInstruments([reliance]), memoryStore());
    const resolved = await resolver.execute(reliance.id);
    expect(resolved.instrumentId).toBe(reliance.id);
    expect(resolved.yahooSymbol).toBe("RELIANCE.NS");
  });

  it("resolves an ISIN and a display-name alias", async () => {
    const store = memoryStore();
    await store.upsertAlias({ alias: "reliance", instrumentId: reliance.id });
    const resolver = new ResolveInstrument(memoryInstruments([reliance]), store);
    await expect(resolver.execute("INE002A01018")).resolves.toMatchObject({ symbol: "RELIANCE" });
    await expect(resolver.execute("Reliance")).resolves.toMatchObject({ instrumentId: reliance.id });
  });

  it("resolves RELIANCE.NS through the existing Yahoo spelling rule", async () => {
    const resolver = new ResolveInstrument(memoryInstruments([reliance]), memoryStore());
    await expect(resolver.execute("RELIANCE.NS")).resolves.toMatchObject({ symbol: "RELIANCE" });
  });

  it("refuses an unknown query instead of guessing", async () => {
    const resolver = new ResolveInstrument(memoryInstruments([reliance]), memoryStore());
    await expect(resolver.execute("NotAStock")).rejects.toBeInstanceOf(InstrumentResolveError);
  });
});

describe("SeedStockIntelligenceUniverse", () => {
  it("registers current Nifty 50 + Next 50 names as inactive and dates membership at the roster freeze", async () => {
    const instruments = memoryInstruments([instrument({ id: "existing-reliance", symbol: "RELIANCE" })]);
    const store = memoryStore();
    const result = await new SeedStockIntelligenceUniverse(instruments, store).execute();

    expect(result.rosterAsOf).toBe(STOCK_INTELLIGENCE_ROSTER_AS_OF);
    expect(result.instrumentsReused).toBeGreaterThanOrEqual(1);
    expect(result.instrumentsCreated + result.instrumentsReused).toBe(stockIntelligenceEquityRoster().length + 3);
    expect(result.survivorshipLimitation).toMatch(/not a reconstructed/i);

    const created = await instruments.findByExchangeAndSymbol("NSE", "TRENT");
    expect(created?.isActive).toBe(false);
    const live = await instruments.findByExchangeAndSymbol("NSE", "RELIANCE");
    expect(live?.id).toBe("existing-reliance");

    const memberships = await store.listMemberships(created!.id);
    expect(memberships[0]?.availableAt.toISOString()).toBe("2026-09-03T00:00:00.000Z");
    expect(memberships[0]?.provenance).toBe("current_roster_snapshot");
  });
});

describe("YahooMarketDataAdapter", () => {
  it("drops bars whose close is after data_cutoff and never asks the provider past the cutoff", async () => {
    const requested: Array<{ from: Date; to: Date; providerInstrumentId: string }> = [];
    const provider: HistoricalMarketDataProvider = {
      id: "yahoo",
      fetchCandles: async (request) => {
        requested.push({ from: request.from, to: request.to, providerInstrumentId: request.providerInstrumentId });
        const bars: HistoricalMarketCandle[] = [
          candle("2026-08-31"),
          candle("2026-09-01"),
          candle("2026-09-03"),
        ];
        return bars;
      },
    };
    const cutoff = new Date("2026-09-02T00:00:00.000Z");
    const adapter = new YahooMarketDataAdapter(provider);
    const bars = await adapter.fetchDailyBars({
      instrumentId: "inst-1",
      symbol: "RELIANCE",
      from: new Date("2026-08-01T00:00:00.000Z"),
      to: new Date("2026-09-10T00:00:00.000Z"),
      dataCutoff: cutoff,
    });

    expect(requested[0]?.providerInstrumentId).toBe("RELIANCE.NS");
    expect(requested[0]?.to.toISOString()).toBe(cutoff.toISOString());
    expect(bars.map((bar) => bar.closeTime.toISOString())).toEqual([
      "2026-08-31T00:00:00.000Z",
      "2026-09-01T00:00:00.000Z",
    ]);
  });
});

describe("investor-facing gate", () => {
  it("blocks on unknown existence or stale market data before any forecast is shown", () => {
    expect(investorFacingBlockedReason({
      eligibility: { eligible: false, reason: "EXISTENCE_UNKNOWN", membership: null },
      fundamentalCompleteness: 1,
      marketDataAgeDays: 1,
      horizon: "6M",
      staleThresholds: { days6M: 30, days12M: 60 },
    })).toBe("INSUFFICIENT_DATA");

    expect(investorFacingBlockedReason({
      eligibility: { eligible: true, reason: "ELIGIBLE", membership: null },
      fundamentalCompleteness: 0.9,
      marketDataAgeDays: 40,
      horizon: "6M",
      staleThresholds: { days6M: 30, days12M: 60 },
    })).toBe("STALE_DATA");
  });
});

function candle(day: string): HistoricalMarketCandle {
  const openTime = new Date(`${day}T00:00:00.000Z`);
  return {
    openTime,
    closeTime: openTime,
    open: "100",
    high: "101",
    low: "99",
    close: "100.5",
    volume: "1",
  };
}
