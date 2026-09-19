import { Pool, type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgresTradeReviewRepository } from "./postgres-trade-review-repository.js";
import type { TradeReview } from "../../../modules/paper-trading/domain/trade-review.js";
import type { DatabaseClient } from "../database.js";

/**
 * `countResearchTags`'s scoping, against a real database.
 *
 * Every test runs inside a transaction that is rolled back, following
 * `postgres-candidate-dataset.test.ts` -- nothing here needs to survive past its own test, and a
 * rollback means the suite can run repeatedly without accumulating rows in shared tables like
 * `instruments` and `paper_accounts`.
 *
 * The point of testing this against real Postgres rather than a mocked client: the whole change is
 * a JOIN plus a `jsonb_array_elements_text` unnest plus a `LIMIT` fed a possibly-NULL parameter, and
 * a mock cannot tell a correct join from one that silently cross-joins or drops rows. `LIMIT NULL`
 * meaning "no limit" was confirmed directly against this same database before writing the query --
 * see the session that built this file -- rather than assumed from memory of the Postgres docs.
 */
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("PostgresTradeReviewRepository.countResearchTags scoping (live DB)", () => {
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

  const scoped = (): DatabaseClient => client as unknown as DatabaseClient;

  async function insertInstrument(symbol: string): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO instruments (exchange, symbol, display_name, instrument_type)
      VALUES ('NSE', $1, $1, 'INDEX')
      RETURNING id
    `, [symbol]);
    return result.rows[0]!.id;
  }

  async function insertAccount(name: string): Promise<string> {
    const result = await client.query<{ id: string }>(`
      INSERT INTO paper_accounts (name, opening_balance)
      VALUES ($1, 1000000)
      RETURNING id
    `, [name]);
    return result.rows[0]!.id;
  }

  /** `strategy: null` means no linked trade idea at all -- the "absence stays absence" case. */
  async function insertTrade(input: {
    accountId: string;
    instrumentId: string;
    strategy: string | null;
    closedAt: Date;
  }): Promise<string> {
    let tradeIdeaId: string | null = null;
    if (input.strategy !== null) {
      const idea = await client.query<{ id: string }>(`
        INSERT INTO trade_ideas (
          instrument_id, side, entry_price, stop_loss, target_price, risk_reward, confidence,
          reasoning, evidence
        ) VALUES ($1, 'LONG', 100, 90, 130, 3, 0.7, '["test"]'::jsonb, $2::jsonb)
        RETURNING id
      `, [input.instrumentId, JSON.stringify({ strategy: input.strategy })]);
      tradeIdeaId = idea.rows[0]!.id;
    }

    const trade = await client.query<{ id: string }>(`
      INSERT INTO paper_trades (
        account_id, trade_idea_id, instrument_id, side, status, quantity, remaining_quantity,
        entry_price, stop_loss, initial_stop_loss, stop_loss_effective_at, target_price,
        opened_at, closed_at, exit_price, exit_reason, realized_pnl
      ) VALUES ($1, $2, $3, 'LONG', 'CLOSED', 75, 0, 100, 90, 90, $4, 130, $4, $4, 110, 'TARGET', 750)
      RETURNING id
    `, [input.accountId, tradeIdeaId, input.instrumentId, input.closedAt]);
    return trade.rows[0]!.id;
  }

  function reviewFor(tradeId: string, tags: string[]): TradeReview {
    return {
      tradeId,
      outcome: "WIN",
      exitReason: "TARGET",
      realizedPnl: 750,
      riskPerUnit: 10,
      realizedR: 3,
      maximumAdverseExcursion: null,
      maximumFavourableExcursion: null,
      maximumAdverseExcursionR: null,
      maximumFavourableExcursionR: null,
      candlesObserved: 0,
      observedTimeframe: null,
      observations: [],
      proposedResearchTags: tags,
    };
  }

  it("is unscoped by default: still a plain all-time global count, unaffected by the new scope options", async () => {
    // This runs against the real shared database (rolled back after), which already carries
    // hundreds of historical reviews -- so the unscoped call is deliberately checked additively
    // (before/after), not against a clean-slate exact count, since a clean slate isn't the truth
    // an unscoped call has ever reported.
    const instrumentA = await insertInstrument("SCOPE-TEST-A");
    const instrumentB = await insertInstrument("SCOPE-TEST-B");
    const account = await insertAccount("scope-test-default");
    const repository = new PostgresTradeReviewRepository(scoped());

    const countOf = (rows: Array<{ tag: string; tradeCount: number }>, tag: string): number =>
      rows.find((row) => row.tag === tag)?.tradeCount ?? 0;
    const before = await repository.countResearchTags();

    const tradeA = await insertTrade({
      accountId: account, instrumentId: instrumentA, strategy: "momentum-scalp",
      closedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    const tradeB = await insertTrade({
      accountId: account, instrumentId: instrumentB, strategy: null,
      closedAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    await repository.save(reviewFor(tradeA, ["NO_FOLLOW_THROUGH"]));
    await repository.save(reviewFor(tradeB, ["NO_FOLLOW_THROUGH", "LOSS_EXCEEDED_STOP"]));

    const after = await repository.countResearchTags();
    expect(countOf(after, "NO_FOLLOW_THROUGH")).toBe(countOf(before, "NO_FOLLOW_THROUGH") + 2);
    expect(countOf(after, "LOSS_EXCEEDED_STOP")).toBe(countOf(before, "LOSS_EXCEEDED_STOP") + 1);
  });

  it("scopes by instrument", async () => {
    const instrumentA = await insertInstrument("SCOPE-TEST-INST-A");
    const instrumentB = await insertInstrument("SCOPE-TEST-INST-B");
    const account = await insertAccount("scope-test-instrument");
    const repository = new PostgresTradeReviewRepository(scoped());

    const tradeA = await insertTrade({
      accountId: account, instrumentId: instrumentA, strategy: null,
      closedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    const tradeB = await insertTrade({
      accountId: account, instrumentId: instrumentB, strategy: null,
      closedAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    await repository.save(reviewFor(tradeA, ["GAVE_BACK_FAVOURABLE_MOVE"]));
    await repository.save(reviewFor(tradeB, ["GAVE_BACK_FAVOURABLE_MOVE"]));

    expect(await repository.countResearchTags({ instrumentId: instrumentA })).toEqual([
      { tag: "GAVE_BACK_FAVOURABLE_MOVE", tradeCount: 1 },
    ]);
  });

  it("scopes by strategy, and a trade with no linked idea never matches a strategy filter", async () => {
    const instrument = await insertInstrument("SCOPE-TEST-STRAT");
    const account = await insertAccount("scope-test-strategy");
    const repository = new PostgresTradeReviewRepository(scoped());

    const scalpTrade = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: "momentum-scalp",
      closedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    const otherStrategyTrade = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: "some-other-strategy",
      closedAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    const noIdeaTrade = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: null,
      closedAt: new Date("2026-09-03T10:00:00.000Z"),
    });
    await repository.save(reviewFor(scalpTrade, ["NO_FOLLOW_THROUGH"]));
    await repository.save(reviewFor(otherStrategyTrade, ["NO_FOLLOW_THROUGH"]));
    await repository.save(reviewFor(noIdeaTrade, ["NO_FOLLOW_THROUGH"]));

    expect(await repository.countResearchTags({ strategy: "momentum-scalp" })).toEqual([
      { tag: "NO_FOLLOW_THROUGH", tradeCount: 1 },
    ]);
  });

  it("limits to the most recent N matching trades by closed_at", async () => {
    const instrument = await insertInstrument("SCOPE-TEST-RECENCY");
    const account = await insertAccount("scope-test-recency");
    const repository = new PostgresTradeReviewRepository(scoped());

    const oldest = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: "momentum-scalp",
      closedAt: new Date("2026-09-01T10:00:00.000Z"),
    });
    const middle = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: "momentum-scalp",
      closedAt: new Date("2026-09-02T10:00:00.000Z"),
    });
    const newest = await insertTrade({
      accountId: account, instrumentId: instrument, strategy: "momentum-scalp",
      closedAt: new Date("2026-09-03T10:00:00.000Z"),
    });
    // Distinct tags per trade, so the count itself proves which trades were included.
    await repository.save(reviewFor(oldest, ["STOP_NEARLY_HIT"]));
    await repository.save(reviewFor(middle, ["EXITED_BELOW_PEAK"]));
    await repository.save(reviewFor(newest, ["NO_FOLLOW_THROUGH"]));

    const counts = await repository.countResearchTags({
      instrumentId: instrument, strategy: "momentum-scalp", recentTradeLimit: 2,
    });
    expect(counts.map((row) => row.tag).sort()).toEqual(["EXITED_BELOW_PEAK", "NO_FOLLOW_THROUGH"]);
  });

  it("rejects a non-positive or non-integer recentTradeLimit", async () => {
    const repository = new PostgresTradeReviewRepository(scoped());
    await expect(repository.countResearchTags({ recentTradeLimit: 0 })).rejects.toThrow(/positive integer/);
    await expect(repository.countResearchTags({ recentTradeLimit: -1 })).rejects.toThrow(/positive integer/);
    await expect(repository.countResearchTags({ recentTradeLimit: 1.5 })).rejects.toThrow(/positive integer/);
  });
});
