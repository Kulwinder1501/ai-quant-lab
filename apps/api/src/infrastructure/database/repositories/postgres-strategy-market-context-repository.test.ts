import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresStrategyMarketContextRepository } from "./postgres-strategy-market-context-repository.js";
import { PostgresInstrumentRepository } from "./postgres-instrument-repository.js";
import { PostgresCandleRepository } from "./postgres-candle-repository.js";
import { PostgresIndicatorDefinitionRepository } from "./postgres-indicator-definition-repository.js";
import { PostgresIndicatorSnapshotRepository } from "./postgres-indicator-snapshot-repository.js";
import { indicatorParametersHash } from "../../../modules/technical-analysis/application/indicator-parameters-hash.js";
import {
  regimeSourceIndicatorAlgorithmVersion,
  regimeSourceIndicatorCode,
  regimeSourceIndicatorPeriod,
  regimeSourceInstrumentSymbol,
} from "../../../modules/strategy-engine/domain/regime.js";
import type { DatabasePool } from "../database.js";

/**
 * `findRawVolatilityReading`'s persistence guarantee, against a real database.
 *
 * Every test runs inside a transaction that is rolled back, following this repository directory's
 * established pattern (`postgres-decision-ledger.test.ts` etc.). The VIX candle/indicator rows this
 * test seeds use a deliberately far-future `close_time` so they cannot collide with real historical
 * INDIAVIX data already in the live database.
 */
const databaseUrl = process.env.DATABASE_URL;
const FAR_FUTURE_CLOSE_TIME = new Date("2099-01-01T09:20:00.000Z");

describe.skipIf(!databaseUrl)("PostgresStrategyMarketContextRepository.findRawVolatilityReading (live DB)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let client: PoolClient;

  beforeEach(async () => {
    client = await pool.connect();
    await client.query("BEGIN");
  });

  afterEach(async () => {
    await client.query("ROLLBACK");
    client.release();
  });

  afterAll(async () => {
    await pool.end();
  });

  const scoped = (): DatabasePool => client as unknown as DatabasePool;

  /** The source `candle_series_provenance` (migration 043) declares for this instrument/timeframe. */
  async function declaredSourceFor(database: DatabasePool, instrumentId: string, timeframe: string): Promise<string> {
    const result = await database.query<{ source: string }>(
      "SELECT source FROM candle_series_provenance WHERE instrument_id = $1 AND timeframe = $2",
      [instrumentId, timeframe],
    );
    const source = result.rows[0]?.source;
    if (!source) {
      throw new Error(
        `No candle_series_provenance declared for instrument ${instrumentId}/${timeframe} in the live `
        + "database -- this test needs an existing declared source to satisfy the FK.",
      );
    }
    return source;
  }

  /** Seeds a VIX candle at FAR_FUTURE_CLOSE_TIME plus its SMA(20) snapshot, returning the vixClose used. */
  async function seedVix(input: { readonly timeframe: string; readonly vixClose: number; readonly vixSma20: number }): Promise<string> {
    const database = scoped();
    const vixResult = await database.query<{ id: string }>(
      "SELECT id FROM instruments WHERE symbol = $1",
      [regimeSourceInstrumentSymbol],
    );
    const vixInstrumentId = vixResult.rows[0]?.id;
    if (!vixInstrumentId) {
      throw new Error(
        `The live database has no "${regimeSourceInstrumentSymbol}" instrument -- this test assumes the `
        + "core VIX instrument row already exists, the same assumption findRawVix/findRegime make live.",
      );
    }

    const candleRepository = new PostgresCandleRepository(database);
    await candleRepository.upsert({
      instrumentId: vixInstrumentId,
      ingestionId: null,
      timeframe: input.timeframe,
      openTime: new Date(FAR_FUTURE_CLOSE_TIME.getTime() - 60_000),
      closeTime: FAR_FUTURE_CLOSE_TIME,
      open: String(input.vixClose),
      high: String(input.vixClose),
      low: String(input.vixClose),
      close: String(input.vixClose),
      volume: "0",
      isComplete: true,
      // Whichever source is actually declared for INDIAVIX/this timeframe in
      // candle_series_provenance (migration 043's FK rejects any other source on insert) --
      // read live rather than hardcoded, since ownership has been reassigned since that
      // migration's own comment (originally "yahoo", now "fyers-api-v3" for every timeframe).
      source: await declaredSourceFor(database, vixInstrumentId, input.timeframe),
      sourceMetadata: {},
    });
    const candle = await database.query<{ id: string }>(
      "SELECT id FROM candles WHERE instrument_id = $1 AND timeframe = $2 AND close_time = $3",
      [vixInstrumentId, input.timeframe, FAR_FUTURE_CLOSE_TIME],
    );
    const candleId = candle.rows[0]!.id;

    const parameters = { period: regimeSourceIndicatorPeriod };
    const definitionRepository = new PostgresIndicatorDefinitionRepository(database);
    const definition = await definitionRepository.ensure({
      code: regimeSourceIndicatorCode,
      algorithmVersion: regimeSourceIndicatorAlgorithmVersion,
      parameters,
      parametersHash: indicatorParametersHash(parameters),
      outputSchema: { value: "number" },
    });

    const snapshotRepository = new PostgresIndicatorSnapshotRepository(database);
    await snapshotRepository.upsertMany([{
      candleId,
      indicatorDefinitionId: definition.id,
      values: { value: input.vixSma20 },
    }]);

    return vixInstrumentId;
  }

  async function seedTargetInstrument(symbol: string): Promise<string> {
    const instrument = await new PostgresInstrumentRepository(scoped()).upsert({
      exchange: "NSE",
      symbol,
      displayName: symbol,
      instrumentType: "INDEX",
      isin: null,
      tickSize: "0.05",
      lotSize: 1,
      isActive: true,
      metadata: {},
      underlyingSymbol: null,
      strikePrice: null,
      expiryDate: null,
      optionType: null,
    });
    return instrument.id;
  }

  it("returns the raw VIX close and SMA(20) pair, not a derived regime", async () => {
    await seedVix({ timeframe: "1m", vixClose: 13.5, vixSma20: 12.0 });
    const targetId = await seedTargetInstrument("TEST_TARGET_RAW_VIX");

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    const reading = await repository.findRawVolatilityReading({
      instrumentId: targetId,
      timeframe: "1m",
      closeTime: FAR_FUTURE_CLOSE_TIME,
    });

    expect(reading).toEqual({ vixClose: 13.5, vixSma20: 12.0 });
  });

  it("returns null when the target instrument is the VIX instrument itself", async () => {
    const vixInstrumentId = await seedVix({ timeframe: "1m", vixClose: 13.5, vixSma20: 12.0 });

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    const reading = await repository.findRawVolatilityReading({
      instrumentId: vixInstrumentId,
      timeframe: "1m",
      closeTime: FAR_FUTURE_CLOSE_TIME,
    });

    expect(reading).toBeNull();
  });

  it("returns null when the VIX reading is outside the staleness window", async () => {
    await seedVix({ timeframe: "1m", vixClose: 13.5, vixSma20: 12.0 });
    const targetId = await seedTargetInstrument("TEST_TARGET_STALE_VIX");

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    // 1m staleness window is 5 bars = 5 minutes; 10 minutes later is well outside it.
    const reading = await repository.findRawVolatilityReading({
      instrumentId: targetId,
      timeframe: "1m",
      closeTime: new Date(FAR_FUTURE_CLOSE_TIME.getTime() + 10 * 60_000),
    });

    expect(reading).toBeNull();
  });
});
