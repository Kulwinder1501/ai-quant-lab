import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_ATR_STOP_MULTIPLE,
  AGENT_FEE_PER_ORDER_INR,
  AGENT_SLIPPAGE_BPS,
  AiAutonomousAgent,
  agentSlippageInr,
  MAX_RETAINED_THOUGHTS,
  PRODUCTION_INDICATOR_VERSION,
} from "./ai-autonomous-agent.js";

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
    return { rows: [] };
  };
  const query = vi.fn(async (sql: string) => answer(sql));
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  } as unknown as FakePool;
}

const BULLISH_CONTEXT = {
  candle: {
    id: "candle-1",
    instrumentId: "inst-1",
    timeframe: "15m",
    openTime: new Date("2026-08-10T04:00:00.000Z"),
    closeTime: new Date("2026-08-10T04:15:00.000Z"),
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

function buildAgent(overrides: {
  database: FakePool;
  context?: unknown;
  openTrades?: unknown[];
  newsScore?: number;
  articleCount?: number;
}) {
  const openFromTradeIdea = vi.fn(async (input: Record<string, unknown>) => ({
    id: "trade-1", ...input,
  }));
  const saveProposal = vi.fn(async (input: Record<string, unknown>) => ({ id: "idea-1", ...input }));
  const close = vi.fn(async () => ({ id: "trade-1" }));
  const updateStopLoss = vi.fn(async (_id: string, _newStopLoss: number, _reason?: string) => undefined);

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
    { getRecentReflections: vi.fn(async () => []), saveReflection: vi.fn() } as never,
  );
  return { agent, openFromTradeIdea, saveProposal, close, updateStopLoss };
}

describe("agentSlippageInr", () => {
  it("scales with turnover rather than being a flat rupee figure", () => {
    // The literal it replaces was 15 rupees regardless of position value.
    expect(agentSlippageInr(24_000, 75)).toBeCloseTo(24_000 * 75 * (AGENT_SLIPPAGE_BPS / 10_000), 2);
    expect(agentSlippageInr(100, 1)).toBeLessThan(agentSlippageInr(24_000, 75));
  });
});

describe("AiAutonomousAgent.tick", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sizes the position from instruments.lot_size, not a hardcoded 50/25", async () => {
    // 75 is deliberately neither of the literals the agent used to choose between.
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, openFromTradeIdea } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(openFromTradeIdea).toHaveBeenCalledTimes(1);
    expect(openFromTradeIdea.mock.calls[0]![0]).toMatchObject({ quantity: 75 });
  });

  it("charges the declared fee and turnover-scaled slippage on entry", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 75 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, openFromTradeIdea } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    const booked = openFromTradeIdea.mock.calls[0]![0] as Record<string, number>;
    expect(booked.entryFees).toBe(AGENT_FEE_PER_ORDER_INR);
    expect(booked.entrySlippage).toBeCloseTo(agentSlippageInr(24_050, 75), 2);
    // The literals that used to be here.
    expect(booked.entryFees).not.toBe(40);
    expect(booked.entrySlippage).not.toBe(15);
  });

  it("refuses to execute when lot_size is missing rather than guessing one", async () => {
    const database = fakePool({
      instruments: [{ id: "inst-1", lot_size: 0 }],
      strategyVersions: [{ id: "sv-1" }],
    });
    const { agent, openFromTradeIdea } = buildAgent({ database });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(openFromTradeIdea).not.toHaveBeenCalled();
    expect(agent.getThoughts(5).some((t) => /no usable lot_size/i.test(t.message))).toBe(true);
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

  it("books a SHORT on bearish evidence, bracketed the right way round", async () => {
    // The case that used to misfire: a strong bearish pattern raised the *bullish* score by 20
    // and then flipped the side, so the position traded on a number built for a long. RSI 40 and
    // negative news now make the short thesis the stronger one on its own terms.
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
    const { agent, saveProposal, openFromTradeIdea } = buildAgent({
      database, context: bearishContext, newsScore: -0.3,
    });

    await agent.tick("NIFTY50", "15m", 24_050);

    expect(openFromTradeIdea).toHaveBeenCalledTimes(1);
    const proposal = saveProposal.mock.calls[0]![0] as Record<string, number | string>;
    expect(proposal.side).toBe("SHORT");
    // A short's stop sits *above* the entry and its target below -- the geometry has to follow
    // the side, or the bracket is inverted the moment the side is no longer hardcoded.
    expect(proposal.stopLoss).toBeGreaterThan(24_050);
    expect(proposal.targetPrice).toBeLessThan(24_050);
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
