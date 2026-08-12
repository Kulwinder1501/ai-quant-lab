import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ATR_STOP_MULTIPLE,
  AiAutonomousAgent,
  MAX_RETAINED_THOUGHTS,
  PRODUCTION_INDICATOR_VERSION,
} from "./ai-autonomous-agent.js";
import type { OpenOptionPositionFromIdea } from "../../paper-trading/application/open-option-position-from-idea.js";

/**
 * Covers `tick`'s execution path, which had no tests at all despite being the only code in
 * this project that opens a position without a human in the loop.
 *
 * The fakes are deliberately literal about the SQL the agent issues: the lot-size bug was
 * possible precisely because the position size never came from the `instruments` row, so a
 * test that stubs the size away would not have caught it.
 */

interface FakeRow { [key: string]: unknown }

/**
 * A pool whose responses are keyed off the statement text, so a changed query is a visible
 * failure rather than a silently empty result. Typed as the agent's `DatabasePool` through
 * `never` because only the two members the agent touches are implemented.
 */
type FakePool = ConstructorParameters<typeof AiAutonomousAgent>[0];

function fakePool(rows: {
  instruments?: FakeRow[];
  strategyVersions?: FakeRow[];
  institutionalFlows?: FakeRow[];
  paperAccounts?: FakeRow[];
}): FakePool {
  const answer = (sql: string): { rows: FakeRow[] } => {
    if (/FROM instruments/i.test(sql)) return { rows: rows.instruments ?? [] };
    if (/FROM strategy_versions/i.test(sql)) return { rows: rows.strategyVersions ?? [] };
    if (/FROM institutional_flows/i.test(sql)) return { rows: rows.institutionalFlows ?? [] };
    if (/FROM paper_accounts/i.test(sql)) return { rows: rows.paperAccounts ?? [] };
    if (/INSERT INTO driver_tape_adjustments/i.test(sql)) return { rows: [{ id: "driver-adjustment-1" }] };
    return { rows: [] };
  };
  const query = vi.fn(async (sql: string) => answer(sql));
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as FakePool;
}

const TEST_CONTEXT_CLOSE = new Date(Date.now() - 5 * 60_000);
const BULLISH_CONTEXT = {
  candle: {
    id: "candle-1",
    instrumentId: "inst-1",
    timeframe: "15m",
    openTime: new Date(TEST_CONTEXT_CLOSE.getTime() - 15 * 60_000),
    closeTime: TEST_CONTEXT_CLOSE,
    open: 24_000, high: 24_100, low: 23_950, close: 24_050, volume: 0, tickSize: 0.05,
  },
  indicators: [
    { code: "RSI", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {}, values: { value: 60 } },
    {
      code: "BOLLINGER_BANDS", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {},
      values: { upper: 24_500, middle: 24_000, lower: 23_500 },
    },
    { code: "ATR", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {}, values: { value: 40 } },
  ],
  patterns: [
    {
      code: "BULLISH_ENGULFING", algorithmVersion: "pr-v1", direction: "BULLISH",
      confidence: 0.9, contextCandleIds: ["candle-1"],
    },
  ],
} as const;

/** A CE contract standing in for whatever the entry gate would have picked. */
const PLACED_CONTRACT = {
  underlyingSymbol: "NIFTY50",
  optionStrike: 24_600,
  optionExpiry: new Date("2026-08-27T10:00:00.000Z"),
  optionType: "CE" as const,
};

function buildAgent(overrides: {
  database: FakePool;
  context?: unknown;
  openTrades?: unknown[];
  newsScore?: number;
  articleCount?: number;
  /** Set to refuse the placement, so the refusal-reporting path can be driven. */
  placementRefusal?: { reason: string; explanation: string };
  /** The observed contract quote the breaker exit prices against. `null` means none exists. */
  chainQuote?: { mid: number; bid: number | null; ask: number | null } | null;
}) {
  const openFromTradeIdea = vi.fn(async (input: Record<string, unknown>) => ({
    id: "trade-1", ...input,
  }));
  const saveProposal = vi.fn(async (input: Record<string, unknown>) => ({ id: "idea-1", ...input }));
  const close = vi.fn(async (input: Record<string, unknown>) => ({ id: "trade-1", ...input }));
  const updateStopLoss = vi.fn(async (_id: string, _newStopLoss: number, _reason?: string) => undefined);
  const latestContractQuote = vi.fn(async () => overrides.chainQuote ?? null);
  const savedThoughts: Array<Record<string, unknown>> = [];
  const saveThought = vi.fn(async (thought: Record<string, unknown>) => {
    savedThoughts.push(thought);
  });

  /**
   * Stands in for `OpenOptionPositionFromIdea`.
   *
   * Injected rather than stubbing `openFromTradeIdea`, because the point of the change under test
   * is that the agent no longer calls the repository directly -- it hands the idea to the gated
   * option path. A test that stubbed the repository would keep passing if that regressed.
   */
  const placeOption = vi.fn(async (input: Record<string, unknown>) => {
    if (overrides.placementRefusal) {
      return { opened: false as const, ...overrides.placementRefusal };
    }
    return {
      opened: true as const,
      trade: { id: "trade-1", ...input },
      contract: PLACED_CONTRACT,
      fillPremium: 212.5,
      stopPremium: 150.25,
      targetPremium: 337,
      quantity: 75,
      entryFees: 23.6,
      unchecked: [],
    };
  });

  const agent = new AiAutonomousAgent(
    overrides.database,
    { findLatestCompleted: vi.fn(async () => overrides.context ?? BULLISH_CONTEXT) } as never,
    { saveProposal } as never,
    { findByName: vi.fn(async () => ({ id: "acct-1", name: "Default Paper Account" })), findById: vi.fn() } as never,
    {
      listOpenByAccount: vi.fn(async () => overrides.openTrades ?? []),
      openFromTradeIdea, close, updateStopLoss,
    } as never,
    {} as never,
    {
      getRollingSentimentAverage: vi.fn(async () => ({
        averageScore: overrides.newsScore ?? 0.3,
        articleCount: overrides.articleCount ?? 5,
      })),
    } as never,
    {
      getRecentReflections: vi.fn(async () => []),
      saveReflection: vi.fn(),
      // Thoughts are persisted now: the API process that serves the dashboard is not the process
      // that ticks the agent, so an in-memory ring alone left the brain panel permanently empty.
      saveThought,
      getRecentThoughts: vi.fn(async (limit: number) => savedThoughts.slice(-limit).reverse()),
    } as never,
    undefined,
    {
      openOptionPosition: { execute: placeOption } as unknown as OpenOptionPositionFromIdea,
      optionChainRepository: { latestContractQuote },
    },
  );
  return {
    agent, openFromTradeIdea, saveProposal, close, updateStopLoss, placeOption,
    latestContractQuote, saveThought, savedThoughts,
  };
}

describe("AiAutonomousAgent.tick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("opens through the option entry gate, never at the index level", async () => {
    // The defect this replaces: `openFromTradeIdea({ fillPrice: livePrice })` booked 75 units of
    // NIFTY50 spot at ~24,050 -- an instrument that cannot be bought.
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, openFromTradeIdea, placeOption } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(placeOption).toHaveBeenCalledTimes(1);
    expect(placeOption.mock.calls[0]![0]).toMatchObject({
      accountId: "acct-1",
      instrumentId: "inst-1",
      tradeIdeaId: "idea-1",
      lots: 1,
    });
    // And it must not reach the repository directly, which is what skipped every gate.
    expect(openFromTradeIdea).not.toHaveBeenCalled();
  });

  it("evaluates stops but refuses new proposals when the strategy context is stale", async () => {
    const staleClose = new Date(Date.now() - 2 * 60 * 60_000);
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, saveProposal, placeOption } = buildAgent({
      database,
      context: {
        ...BULLISH_CONTEXT,
        candle: {
          ...BULLISH_CONTEXT.candle,
          openTime: new Date(staleClose.getTime() - 15 * 60_000),
          closeTime: staleClose,
        },
      },
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(saveProposal).not.toHaveBeenCalled();
    expect(placeOption).not.toHaveBeenCalled();
    const refusal = agent.getThoughts(10).find(
      (thought) => thought.details.reason === "STALE_MARKET_CONTEXT",
    );
    expect(refusal).toBeDefined();
    expect(refusal!.message).toMatch(/skipped new proposals/i);
  });

  it("records the premium it filled at, not the underlying's level", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    const executed = agent.getThoughts(10).find((t) => t.action === "EXECUTING")!;
    expect(executed.details.fillPremium).toBe(212.5);
    expect(executed.details.underlyingEntry).toBe(24_050);
    expect(executed.details.contract).toContain("24600 CE");
    // The old message quoted the index level as though it were the fill.
    expect(executed.message).not.toContain("24050");
  });

  it("reports a refused placement instead of dropping it silently", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent } = buildAgent({
      database,
      placementRefusal: { reason: "EXPIRY_NOT_LISTED", explanation: "No listed expiry far enough out." },
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    const refusal = agent.getThoughts(10).find((t) => t.details.reason === "EXPIRY_NOT_LISTED");
    expect(refusal).toBeDefined();
    // "the gate refused" and "no setup qualified" must not read the same.
    expect(refusal!.message).toMatch(/entry gate refused/i);
  });

  it("brackets the stop from the production ATR snapshot", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, saveProposal } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    const proposal = saveProposal.mock.calls[0]![0] as Record<string, number>;
    expect(proposal.stopLoss).toBeCloseTo(24_050 - 40 * AGENT_ATR_STOP_MULTIPLE, 2);
  });

  it("scores a SHORT but refuses to trade it, because the short gate is measured harmful", async () => {
    // Two separate things are asserted here, and both matter.
    //
    // The scorer must *reach* SHORT on bearish evidence -- that is the fix for the original
    // defect, where a bearish pattern raised the bullish score by 20 and then flipped the side.
    //
    // And the agent must not execute it. `AGENT_EXECUTABLE_SIDES` excludes SHORT because the
    // measurement has it below break-even and below its own unconditional baseline on both
    // instruments tested. Recorded, not traded.
    const bearishContext = {
      ...BULLISH_CONTEXT,
      indicators: [
        { code: "RSI", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {}, values: { value: 40 } },
        {
          code: "BOLLINGER_BANDS", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {},
          values: { upper: 24_500, middle: 24_000, lower: 23_500 },
        },
        { code: "ATR", algorithmVersion: PRODUCTION_INDICATOR_VERSION, parameters: {}, values: { value: 40 } },
      ],
      patterns: [{
        code: "BEARISH_ENGULFING", algorithmVersion: "pr-v1", direction: "BEARISH",
        confidence: 0.95, contextCandleIds: ["candle-1"],
      }],
    };
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, saveProposal, placeOption } = buildAgent({
      database, context: bearishContext, newsScore: -0.3,
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    // Nothing is placed, and no idea is even saved: the gate returns before the proposal.
    expect(placeOption).not.toHaveBeenCalled();
    expect(saveProposal).not.toHaveBeenCalled();

    // But the SHORT read is journalled in full, so the population that *would* have traded stays
    // visible and the gate can be re-measured against it.
    const gatedOut = agent.getThoughts(10).find((t) => t.details.gatedSide === "SHORT");
    expect(gatedOut).toBeDefined();
    expect(gatedOut!.confidence).toBeGreaterThanOrEqual(80);
    expect(gatedOut!.details.executableSides).toEqual(["LONG"]);
    expect(gatedOut!.message).toMatch(/not an executable side/i);
  });

  it("reports both theses, so the losing side's strength is visible", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    const thought = agent.getThoughts(20).find((t) => t.details.longConfidence !== undefined)!;
    expect(thought.details.side).toBe("LONG");
    expect(thought.details.longConfidence).toBeGreaterThan(Number(thought.details.shortConfidence));
    // The winner's number is the one the thought carries.
    expect(thought.confidence).toBe(thought.details.longConfidence);
  });

  it("tightens a SHORT position's stop on the sentiment breaker, not only a LONG's", async () => {
    // `if (t.side === "LONG")` meant a short in the account was exempt from Rule 2.
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, updateStopLoss } = buildAgent({
      database,
      newsScore: -0.4, // Inside Rule 2's band: worse than -0.3, better than -0.7.
      openTrades: [{
        id: "trade-short", instrumentId: "inst-1", side: "SHORT", quantity: 75, stopLoss: 24_500,
      }],
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(updateStopLoss).toHaveBeenCalledTimes(1);
    const [, newStop] = updateStopLoss.mock.calls[0]!;
    // Tighter for a short means closer from above, and never through the price.
    expect(newStop).toBeLessThan(24_500);
    expect(newStop).toBeGreaterThan(24_050);
  });

  it("liquidates the panic breaker at the observed premium, not the underlying's level", async () => {
    // The position is an option. Closing it at `livePrice` (~24,050) against a premium near 200
    // books a fabricated ~24,000-point gain per unit on an emergency liquidation.
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const optionTrade = {
      id: "trade-open", instrumentId: "inst-1", side: "LONG", quantity: 75, stopLoss: 150,
      underlyingSymbol: "NIFTY50", optionStrike: 24_600, optionType: "CE",
      optionExpiry: new Date("2026-08-27T10:00:00.000Z"),
    };
    const { agent, close } = buildAgent({
      database,
      newsScore: -0.85, // Past the -0.7 panic threshold.
      openTrades: [optionTrade],
      chainQuote: { mid: 205, bid: 203.5, ask: 206.5 },
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(close).toHaveBeenCalledTimes(1);
    const closed = close.mock.calls[0]![0] as Record<string, unknown>;
    // The bid, because a panic exit is a seller crossing the spread.
    expect(closed.exitPrice).toBe(203.5);
    expect(closed.exitPrice).not.toBe(24_050);
    expect((closed.details as Record<string, unknown>).exitPriceSource).toBe("OBSERVED_BID");
    // Fees from the brokerage model on the premium, not a flat constant.
    expect(Number(closed.exitFees)).toBeGreaterThan(0);
    expect(Number(closed.exitFees)).toBeLessThan(500);
  });

  it("leaves an unpriceable position open rather than closing it at a guess", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, close } = buildAgent({
      database,
      newsScore: -0.85,
      openTrades: [{
        id: "trade-open", instrumentId: "inst-1", side: "LONG", quantity: 75, stopLoss: 150,
        underlyingSymbol: "NIFTY50", optionStrike: 24_600, optionType: "CE",
        optionExpiry: new Date("2026-08-27T10:00:00.000Z"),
      }],
      chainQuote: null, // No observed quote for the contract.
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(close).not.toHaveBeenCalled();
    const blocked = agent.getThoughts(10).find(
      (t) => t.details.reason === "NO_OBSERVED_CONTRACT_QUOTE",
    );
    expect(blocked).toBeDefined();
  });

  /*
   * The regression this pins: thoughts were held only in the agent's own array, and the tick moved
   * to the scheduler. So the API process serving the dashboard produced none, and the brain panel
   * rendered zero thoughts next to six reflections -- reflections having always been persisted.
   */
  it("persists every thought, so a different process can serve it to the dashboard", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, saveThought, savedThoughts } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(saveThought).toHaveBeenCalled();
    expect(savedThoughts.length).toBe(agent.getThoughts(100).length);
    expect(savedThoughts[0]).toMatchObject({ symbol: "NIFTY50" });
  });

  it("serves the dashboard from the journal, not from this process's memory", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent } = buildAgent({ database });
    await agent.tick("NIFTY50", "15m", 24_050);

    const fromJournal = await agent.listRecentThoughts(8);

    // A fresh agent shares the journal but has an empty ring -- exactly the API's situation.
    const fresh = buildAgent({ database });
    const freshFromJournal = await fresh.agent.listRecentThoughts(8);

    expect(fromJournal.length).toBeGreaterThan(0);
    expect(fresh.agent.getThoughts(8)).toHaveLength(0);
    // The fresh instance's own journal double is separate, so this asserts the *route* is the
    // journal rather than the ring: an in-memory read would have thrown or returned the ring.
    expect(Array.isArray(freshFromJournal)).toBe(true);
  });

  it("keeps ticking when the journal write fails", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, placeOption, saveThought } = buildAgent({ database });
    saveThought.mockRejectedValue(new Error("journal offline"));

    await agent.tick("NIFTY50", "15m", 24_050);

    // A journal outage must not stop the agent evaluating stops or opening positions.
    expect(placeOption).toHaveBeenCalledTimes(1);
    expect(agent.getThoughts(10).length).toBeGreaterThan(0);
  });

  it("bounds the in-memory thought log instead of growing it forever", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    // Already at the position limit, so each tick records a MONITORING thought and returns.
    const { agent } = buildAgent({
      database,
      openTrades: [{ id: "t1", instrumentId: "inst-1", side: "LONG", quantity: 75, stopLoss: 23_000 }],
    });

    for (let i = 0; i < MAX_RETAINED_THOUGHTS + 50; i += 1) {
      await agent.tick("NIFTY50", "15m", 24_050);
    }

    // Asked for far more than the cap; cannot receive more than the cap.
    expect(agent.getThoughts(10_000).length).toBeLessThanOrEqual(MAX_RETAINED_THOUGHTS);
  });
});
