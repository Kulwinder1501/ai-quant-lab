import { describe, expect, it } from "vitest";
import type { StrategyMarketContext, ProposedTradeIdea } from "./strategy.js";
import {
  evaluateLiquiditySweepBias,
  filterProposalsByLiquiditySweepBias,
} from "./smc-liquidity-bias.js";

function makeCandle(
  id: string,
  timeframe: string,
  openTime: Date,
  closeTime: Date,
) {
  return {
    id,
    instrumentId: "NSE:NIFTY50",
    timeframe,
    openTime,
    closeTime,
    open: 25000,
    high: 25100,
    low: 24900,
    close: 25050,
    volume: 50000,
    tickSize: 0.05,
  };
}

function makeContext(
  timeframe = "1m",
  closeTime = new Date("2026-09-18T04:30:00.000Z"), // 10:00 IST
  indicators: StrategyMarketContext["indicators"] = [],
  htfContexts?: StrategyMarketContext["higherTimeframeContexts"],
): StrategyMarketContext {
  const openTime = new Date(closeTime.getTime() - 60_000);
  return {
    candle: makeCandle(`c-${timeframe}`, timeframe, openTime, closeTime),
    indicators,
    patterns: [],
    priceActionEvents: [],
    higherTimeframeContexts: htfContexts,
  };
}

function makeProposal(side: "LONG" | "SHORT"): ProposedTradeIdea {
  return {
    side,
    entryPrice: 25050,
    stopLoss: side === "LONG" ? 25000 : 25100,
    targetPrice: side === "LONG" ? 25150 : 24950,
    riskReward: 2,
    confidence: 0.7,
    reasoning: ["Base momentum entry"],
    evidence: {},
    expiresAt: null,
    evidenceItems: [],
  };
}

describe("evaluateLiquiditySweepBias", () => {
  it("returns NEUTRAL when base timeframe is slower than HTF timeframe", () => {
    const ctx = makeContext("1d");
    const result = evaluateLiquiditySweepBias(ctx, "15m");
    expect(result.bias).toBe("NEUTRAL");
    expect(result.reason).toContain("is slower than HTF");
  });

  it("evaluates directly on base indicators when base timeframe equals HTF timeframe", () => {
    const ctx = makeContext("15m");
    const result = evaluateLiquiditySweepBias(ctx, "15m");
    expect(result.bias).toBe("NEUTRAL");
    expect(result.reason).toContain("No liquidity sweep or CHOCH detected on 15m candle");
  });

  it("returns NEUTRAL when HTF context is absent", () => {
    const ctx = makeContext("1m");
    const result = evaluateLiquiditySweepBias(ctx, "15m");
    expect(result.bias).toBe("NEUTRAL");
    expect(result.reason).toContain("No completed 15m context attached");
  });

  it("throws lookahead error if HTF candle closed after base candle", () => {
    const baseClose = new Date("2026-09-18T04:30:00.000Z");
    const futureHtfClose = new Date("2026-09-18T04:45:00.000Z");
    const htf = makeContext("15m", futureHtfClose);
    const ctx = makeContext("1m", baseClose, [], { "15m": htf });

    expect(() => evaluateLiquiditySweepBias(ctx, "15m")).toThrow(/HTF_BIAS_LOOKAHEAD/);
  });

  it("returns NEUTRAL if HTF candle is from a previous trading session (enforceSameSession = true)", () => {
    // Yesterday at 15:30 IST (10:00 UTC)
    const yesterdayClose = new Date("2026-09-17T10:00:00.000Z");
    // Today at 09:16 IST (03:46 UTC)
    const todayClose = new Date("2026-09-18T03:46:00.000Z");

    const htf = makeContext("15m", yesterdayClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BULLISH_SWEEP" },
      } as never,
    ]);

    const ctx = makeContext("1m", todayClose, [], { "15m": htf });
    const result = evaluateLiquiditySweepBias(ctx, "15m", { enforceSameSession: true });

    expect(result.bias).toBe("NEUTRAL");
    expect(result.reason).toContain("from previous session");
  });

  it("detects BULLISH bias when 15m carries BULLISH_SWEEP in the same session", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z"); // 09:45 IST
    const baseClose = new Date("2026-09-18T04:20:00.000Z"); // 09:50 IST

    const htf = makeContext("15m", htfClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BULLISH_SWEEP", level: 24950 },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const result = evaluateLiquiditySweepBias(ctx, "15m");

    expect(result.bias).toBe("BULLISH");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].type).toBe("BULLISH_SWEEP");
  });

  it("detects BEARISH bias when 15m carries BEARISH_SWEEP", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z");
    const baseClose = new Date("2026-09-18T04:20:00.000Z");

    const htf = makeContext("15m", htfClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BEARISH_SWEEP", level: 25150 },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const result = evaluateLiquiditySweepBias(ctx, "15m");

    expect(result.bias).toBe("BEARISH");
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].type).toBe("BEARISH_SWEEP");
  });

  it("detects CHOCH signals correctly", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z");
    const baseClose = new Date("2026-09-18T04:20:00.000Z");

    const htf = makeContext("15m", htfClose, [
      {
        code: "CHOCH",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BULLISH_CHOCH" },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const result = evaluateLiquiditySweepBias(ctx, "15m");

    expect(result.bias).toBe("BULLISH");
    expect(result.signals[0].code).toBe("CHOCH");
  });

  it("returns NEUTRAL when bullish and bearish signals are equally balanced", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z");
    const baseClose = new Date("2026-09-18T04:20:00.000Z");

    const htf = makeContext("15m", htfClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BULLISH_SWEEP" },
      } as never,
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BEARISH_SWEEP" },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const result = evaluateLiquiditySweepBias(ctx, "15m");

    expect(result.bias).toBe("NEUTRAL");
    expect(result.reason).toContain("Balanced signals");
  });
});

describe("filterProposalsByLiquiditySweepBias", () => {
  it("passes all proposals unmodified when bias is NEUTRAL", () => {
    const ctx = makeContext("1m"); // no HTF attached -> NEUTRAL
    const proposals = [makeProposal("LONG"), makeProposal("SHORT")];

    const filtered = filterProposalsByLiquiditySweepBias(ctx, proposals, "15m");
    expect(filtered).toHaveLength(2);
  });

  it("admits only LONG proposals and attaches evidence when bias is BULLISH", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z");
    const baseClose = new Date("2026-09-18T04:20:00.000Z");

    const htf = makeContext("15m", htfClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BULLISH_SWEEP", level: 24950 },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const proposals = [makeProposal("LONG"), makeProposal("SHORT")];

    const filtered = filterProposalsByLiquiditySweepBias(ctx, proposals, "15m");

    expect(filtered).toHaveLength(1);
    expect(filtered[0].side).toBe("LONG");
    expect(filtered[0].evidence.htfLiquidityBias).toMatchObject({
      timeframe: "15m",
      bias: "BULLISH",
    });
    expect(filtered[0].reasoning.some((r) => r.includes("HTF Liquidity Bias (15m): Confirmed BULLISH"))).toBe(true);
  });

  it("admits only SHORT proposals when bias is BEARISH", () => {
    const htfClose = new Date("2026-09-18T04:15:00.000Z");
    const baseClose = new Date("2026-09-18T04:20:00.000Z");

    const htf = makeContext("15m", htfClose, [
      {
        code: "LIQUIDITY_SWEEP",
        algorithmVersion: "smc-v2",
        parameters: {},
        values: { type: "BEARISH_SWEEP", level: 25150 },
      } as never,
    ]);

    const ctx = makeContext("1m", baseClose, [], { "15m": htf });
    const proposals = [makeProposal("LONG"), makeProposal("SHORT")];

    const filtered = filterProposalsByLiquiditySweepBias(ctx, proposals, "15m");

    expect(filtered).toHaveLength(1);
    expect(filtered[0].side).toBe("SHORT");
    expect(filtered[0].evidence.htfLiquidityBias).toMatchObject({
      timeframe: "15m",
      bias: "BEARISH",
    });
  });

  it("returns empty array when proposals input is empty", () => {
    const ctx = makeContext("1m");
    expect(filterProposalsByLiquiditySweepBias(ctx, [], "15m")).toEqual([]);
  });
});
