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

/**
 * `computeAndPersistIctSnapshot`'s HTF pillar, against a real database.
 *
 * Before this fix, `engine.processCandle(causalCandles, i)` never received a third `htfBias`
 * argument on the live path, so `coverage.htf` was `NOT_COVERED` on every single call regardless of
 * how much daily-session history existed -- the two live ICT bots (`AutoBot-IctNifty15m`,
 * `AutoBot-IctBankNifty5m`) could never clear Gate 1's `coverage.htf === "COMPLETE"` requirement.
 * This seeds enough synthetic daily-session history (a dedicated, isolated test instrument so it
 * cannot collide with real market data) to prove the live path now derives and threads a real HTF
 * bias through, the same way the replay/backtest path always has.
 */
describe.skipIf(!databaseUrl)("PostgresStrategyMarketContextRepository ICT HTF coverage (live DB)", () => {
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

  /**
   * A synthetic ascending "staircase": a 6-bar up-leg followed by a 4-bar pullback, repeated, each
   * cycle's swing high/low strictly above the previous cycle's. One 5m candle per IST session (so
   * each session IS its own daily HTF bucket), starting from a fixed past date so every close_time
   * is safely `<= CURRENT_TIMESTAMP`. This exact shape confirms an IctStructureTracker(pivotLength=3)
   * trend to BULLISH by session index 8 (proven directly against the tracker before being reused
   * here), which is what carries `coverage.htf` to "COMPLETE" rather than "UNKNOWN": OWN_STRUCTURE
   * bias reads `structure.trend` once it has resolved off NEUTRAL, per `bias.ts`.
   */
  function staircaseSessionCandles(sessions: number): Array<{
    openTime: Date; closeTime: Date; open: number; high: number; low: number; close: number;
  }> {
    const out: Array<{ openTime: Date; closeTime: Date; open: number; high: number; low: number; close: number }> = [];
    let price = 100;
    let dayOffset = 0;
    const upLen = 6;
    const downLen = 4;
    while (out.length < sessions) {
      for (let i = 0; i < upLen && out.length < sessions; i += 1) {
        price += 4;
        out.push(sessionCandle(dayOffset, price - 4, price + 2, price - 5, price));
        dayOffset += 1;
      }
      for (let i = 0; i < downLen && out.length < sessions; i += 1) {
        price -= 2;
        out.push(sessionCandle(dayOffset, price + 2, price + 3, price - 2, price));
        dayOffset += 1;
      }
    }
    return out;
  }

  /** One 5m bar at 09:15 IST, `dayOffset` days after a fixed 2020-01-01 anchor (safely in the past). */
  function sessionCandle(
    dayOffset: number,
    open: number,
    high: number,
    low: number,
    close: number,
  ): { openTime: Date; closeTime: Date; open: number; high: number; low: number; close: number } {
    const openTime = new Date(Date.UTC(2020, 0, 1 + dayOffset, 3, 45)); // 09:15 IST = 03:45 UTC
    const closeTime = new Date(openTime.getTime() + 5 * 60_000);
    return { openTime, closeTime, open, high, low, close };
  }

  it("carries coverage.htf to COMPLETE once enough daily-session history exists", async () => {
    const database = scoped();
    const targetId = await seedTargetInstrument("TEST_TARGET_HTF_COVERAGE");
    const timeframe = "5m"; // AutoBot-IctBankNifty5m's own timeframe; ictContextConsumedAt("5m") is true.

    // A brand-new (instrument, timeframe) pair has no declared provenance yet -- migration 043's FK
    // requires one before any candle can be inserted, so this test declares its own.
    await database.query(
      "INSERT INTO candle_series_provenance (instrument_id, timeframe, source) VALUES ($1, $2, 'test')",
      [targetId, timeframe],
    );

    const candleRepository = new PostgresCandleRepository(database);
    const sessions = staircaseSessionCandles(40);
    for (const session of sessions) {
      await candleRepository.upsert({
        instrumentId: targetId,
        ingestionId: null,
        timeframe,
        openTime: session.openTime,
        closeTime: session.closeTime,
        open: String(session.open),
        high: String(session.high),
        low: String(session.low),
        close: String(session.close),
        volume: "1000",
        isComplete: true,
        source: "test",
        sourceMetadata: {},
      });
    }

    const repository = new PostgresStrategyMarketContextRepository(database);
    const context = await repository.findLatestCompleted({ instrumentId: targetId, timeframe });

    expect(context).not.toBeNull();
    // The defect this fix closes: coverage.htf was NOT_COVERED on every live call, unconditionally,
    // no matter how much daily-session history existed. With that many completed sessions behind it
    // and a resolved (non-NEUTRAL) own-structure trend, it must now be COMPLETE.
    expect(context?.ictSnapshot?.coverage.htf).toBe("COMPLETE");
    expect(context?.ictSnapshot?.htfBias).toBe("BULLISH");
  });
});

/**
 * `resolveOptionChainSignal`'s real PCR as-of join, against a real database.
 *
 * Added 2026-09-28 alongside `hybrid-liquidity-confluence-v1` Pillar C, which used to read a
 * `priceActionEvents[].details.oiSupport/oiResistance` flag that nothing ever set -- a silent,
 * permanent pass. This proves the replacement actually measures a PCR from `option_chain_snapshots`
 * rather than defaulting to one, and that it refuses (null) rather than guessing when nothing has
 * been observed yet or the nearest observation is stale.
 */
describe.skipIf(!databaseUrl)("PostgresStrategyMarketContextRepository.optionChainSignal (live DB)", () => {
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

  async function seedCompletedCandle(
    instrumentId: string,
    timeframe: string,
    closeTime: Date,
  ): Promise<void> {
    const database = scoped();
    await database.query(
      "INSERT INTO candle_series_provenance (instrument_id, timeframe, source) VALUES ($1, $2, 'test') "
      + "ON CONFLICT DO NOTHING",
      [instrumentId, timeframe],
    );
    await new PostgresCandleRepository(database).upsert({
      instrumentId,
      ingestionId: null,
      timeframe,
      openTime: new Date(closeTime.getTime() - 5 * 60_000),
      closeTime,
      open: "100",
      high: "100",
      low: "100",
      close: "100",
      volume: "1000",
      isComplete: true,
      source: "test",
      sourceMetadata: {},
    });
  }

  /** One CE row and one PE row for the same snapshot, nearest un-expired expiry. */
  async function seedChainSnapshot(input: {
    underlyingSymbol: string;
    observedAt: Date;
    callOi: number;
    putOi: number;
  }): Promise<void> {
    const database = scoped();
    const expiryDate = new Date(input.observedAt.getTime() + 7 * 24 * 60 * 60_000).toISOString().slice(0, 10);
    for (const [optionType, oi] of [["CE", input.callOi], ["PE", input.putOi]] as const) {
      await database.query(`
        INSERT INTO option_chain_snapshots (
          underlying_symbol, provider, observed_at, expiry_date, expiry_kind,
          strike_price, option_type, provider_symbol, open_interest
        ) VALUES ($1, 'test', $2, $3, 'WEEKLY', 100, $4, $5, $6)
      `, [input.underlyingSymbol, input.observedAt, expiryDate, optionType, `TEST-100-${optionType}`, oi]);
    }
  }

  it("resolves a real PCR from option_chain_snapshots, not a default pass", async () => {
    const symbol = "TEST_TARGET_PCR_MEASURED";
    const targetId = await seedTargetInstrument(symbol);
    const closeTime = new Date(Date.UTC(2020, 0, 1, 3, 50));
    await seedCompletedCandle(targetId, "5m", closeTime);
    await seedChainSnapshot({
      underlyingSymbol: symbol,
      observedAt: new Date(closeTime.getTime() - 5 * 60_000),
      callOi: 100_000,
      putOi: 140_000,
    });

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    const context = await repository.findLatestCompleted({ instrumentId: targetId, timeframe: "5m" });

    expect(context?.optionChainSignal?.pcr).toBeCloseTo(1.4, 6);
    expect(context?.optionChainSignal?.callOpenInterest).toBe(100_000);
    expect(context?.optionChainSignal?.putOpenInterest).toBe(140_000);
  });

  it("returns pcr: null when no snapshot has been observed yet, rather than defaulting to a pass", async () => {
    const symbol = "TEST_TARGET_PCR_UNMEASURED";
    const targetId = await seedTargetInstrument(symbol);
    const closeTime = new Date(Date.UTC(2020, 0, 1, 3, 50));
    await seedCompletedCandle(targetId, "5m", closeTime);
    // No option_chain_snapshots rows for this symbol at all.

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    const context = await repository.findLatestCompleted({ instrumentId: targetId, timeframe: "5m" });

    expect(context?.optionChainSignal?.pcr).toBeNull();
  });

  it("returns pcr: null when the nearest snapshot is older than the staleness ceiling", async () => {
    const symbol = "TEST_TARGET_PCR_STALE";
    const targetId = await seedTargetInstrument(symbol);
    const closeTime = new Date(Date.UTC(2020, 0, 1, 3, 50));
    await seedCompletedCandle(targetId, "5m", closeTime);
    await seedChainSnapshot({
      underlyingSymbol: symbol,
      // 90 minutes stale -- past the 60-minute ceiling `resolveOptionChainSignal` enforces.
      observedAt: new Date(closeTime.getTime() - 90 * 60_000),
      callOi: 100_000,
      putOi: 140_000,
    });

    const repository = new PostgresStrategyMarketContextRepository(scoped());
    const context = await repository.findLatestCompleted({ instrumentId: targetId, timeframe: "5m" });

    expect(context?.optionChainSignal?.pcr).toBeNull();
  });
});
