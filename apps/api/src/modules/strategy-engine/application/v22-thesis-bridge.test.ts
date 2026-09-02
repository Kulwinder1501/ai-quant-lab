import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  portedV1PolicyVersion,
  portedV1ThesisProducer,
  V22ThesisBridgeError,
} from "./v22-thesis-bridge.js";
import {
  assertMayHoldAuthority,
  nativeStructuralProducer,
  ThesisAuthorityError,
  type ThesisGateInput,
} from "../../autonomous-v2/domain/thesis-producer.js";
import { marketSnapshotFromLegacyContext } from "../../autonomous-v2/application/market-context-adapter.js";
import { MomentumScalpIndexStrategy } from "../domain/momentum-scalp-index-strategy.js";
import type { RegisteredStrategy } from "../domain/strategy-registry.js";
import type { ProposedTradeIdea, StrategyMarketContext } from "../domain/strategy.js";
import type { BarLabelConvention } from "../../platform/pit/pit-instants.js";

const openTime = new Date("2026-09-02T09:20:00.000Z");
const closeTime = new Date("2026-09-02T09:25:00.000Z");
const convention: BarLabelConvention = "CLOSE_LABELLED";

/**
 * A bar that fires V1's momentum-scalp-index SHORT rule.
 *
 * Built from the real thresholds rather than a fixture: Supertrend DOWN, fast EMA below slow, RSI
 * inside 25-45, and an EMA spread of a full ATR so the confidence floor -- 0.3 base + 0.3 spread --
 * clears `minimumConfidence: 0.5`. SHORT because it is the only side the registry still permits on
 * this strategy.
 */
function shortContext(overrides: Partial<StrategyMarketContext["candle"]> = {}): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "instrument-1", timeframe: "5m", openTime, closeTime,
      open: 23_900, high: 23_910, low: 23_840, close: 23_860, volume: 125_000, tickSize: 0.05,
      ...overrides,
    },
    indicators: [
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 3 }, values: { value: 23_840 } },
      { code: "EMA", algorithmVersion: "ta-v1", parameters: { period: 8 }, values: { value: 23_870 } },
      { code: "RSI", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 35 } },
      {
        code: "SUPERTREND", algorithmVersion: "ta-v1", parameters: { atrPeriod: 10, multiplier: 3 },
        values: { trend: "DOWN", value: 23_890 },
      },
      { code: "ATR", algorithmVersion: "ta-v1", parameters: { period: 14, smoothing: "WILDER" }, values: { value: 30 } },
    ],
    patterns: [],
    priceActionEvents: [],
    patternsComputed: true,
    priceActionComputed: true,
  } as unknown as StrategyMarketContext;
}

function gateFor(context: StrategyMarketContext, overrides: Partial<ThesisGateInput> = {}): ThesisGateInput {
  const snapshot = marketSnapshotFromLegacyContext({
    context: {
      candle: context.candle,
      indicators: context.indicators,
      patterns: [],
      priceActionEvents: [],
      patternsComputed: true,
      priceActionComputed: true,
    },
    instants: {
      eventAt: context.candle.closeTime,
      knownAt: new Date(context.candle.closeTime.getTime() + 1_000),
      dataThrough: context.candle.closeTime,
      dataThroughConvention: convention,
      earliestExecutionAt: new Date(context.candle.closeTime.getTime() + 2_000),
      referenceAt: new Date(context.candle.closeTime.getTime() + 2_000),
    },
    labelConvention: convention,
  });
  return {
    snapshot,
    tapeLiveness: "LIVE",
    executableSides: ["SHORT"],
    insideExecutableWindow: true,
    instrumentSymbol: "NIFTY50",
    ...overrides,
  };
}

/** The real index strategy, registered as the only strategy on this timeframe. */
const indexOnly: readonly RegisteredStrategy[] = [{
  StrategyClass: MomentumScalpIndexStrategy,
  supportedTimeframes: ["5m"],
  executableSides: ["SHORT"],
  registration: {
    strategyKey: "momentum-scalp-index",
    name: "Momentum Scalp (Index)",
    description: "test",
    version: 1,
    configuration: {
      indicatorAlgorithmVersion: "ta-v1",
      indicatorParameters: {
        EMA_FAST: { period: 3 }, EMA_SLOW: { period: 8 },
        RSI: { period: 14, smoothing: "WILDER" },
        SUPERTREND: { atrPeriod: 10, multiplier: 3 },
        ATR: { period: 14, smoothing: "WILDER" },
      },
      candlestickAlgorithmVersion: "candlestick-v1",
      priceActionAlgorithmVersion: "price-action-v2",
      rsiLongMin: 55, rsiLongMax: 75, rsiShortMin: 25, rsiShortMax: 45,
      atrStopMultiple: 1.0, rewardRiskMultiple: 1.5, minimumConfidence: 0.5,
      expiryCandles: 3, requireRegime: false,
    },
  },
}] as unknown as readonly RegisteredStrategy[];

/** A stub that proposes fixed geometry, for the cases real strategies cannot be made to produce. */
function stubStrategy(key: string, proposal: Partial<ProposedTradeIdea>): RegisteredStrategy {
  const full: ProposedTradeIdea = {
    side: "SHORT", entryPrice: 23_860, stopLoss: 23_890, targetPrice: 23_815,
    riskReward: 1.5, confidence: 0.7, reasoning: [], evidence: {}, expiresAt: null, evidenceItems: [],
    ...proposal,
  };
  return {
    StrategyClass: class { evaluate(): ProposedTradeIdea[] { return [full]; } },
    supportedTimeframes: ["5m"],
    executableSides: ["SHORT"],
    registration: { strategyKey: key, name: key, description: "test", version: 1, configuration: {} },
  } as unknown as RegisteredStrategy;
}

describe("the ported producer carries V1's rule, not V1's authority", () => {
  it("cannot hold live authority, and the type says so", () => {
    /*
     * Section 6 licenses a legacy thesis for "differential analysis only, not live decisions". As a
     * comment that is unenforceable -- P19 will grant paper authority to some producer, and at that
     * moment something has to refuse this one. The shadow path needs no guard because it holds no
     * execution port at all; this is for the path that will.
     */
    const producer = portedV1ThesisProducer({ context: shortContext(), instrumentSymbol: "NIFTY50" });

    expect(producer.authority).toBe("DIFFERENTIAL_ONLY");
    expect(() => assertMayHoldAuthority(producer)).toThrow(ThesisAuthorityError);
    expect(() => assertMayHoldAuthority(producer)).toThrow(/re-derive/);
  });

  it("leaves V2.2's own producer authorised", () => {
    // The guard must discriminate, not refuse everything: a blanket refusal would pass this file's
    // tests and block the native path P19 is actually meant to enable.
    expect(nativeStructuralProducer.authority).toBe("NATIVE");
    expect(() => assertMayHoldAuthority(nativeStructuralProducer)).not.toThrow();
  });

  it("never reads V1's composite confidence", () => {
    /*
     * A tripwire, checked against source. The composite is quarantined by name, and the tempting
     * shortcut when two candidates appear is to rank them by `proposal.confidence` -- which would
     * rebuild `scoreDirectionalSetup` inside the migration path. V1 may apply its own floor while
     * deciding whether to return a proposal; V2.2 must never see the number.
     */
    const source = readFileSync(
      resolve(process.cwd(), "src", "modules", "strategy-engine", "application", "v22-thesis-bridge.ts"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*/g, "$1 ");

    expect(source).not.toMatch(/\.confidence\b/);
    expect(source).not.toMatch(/\bscoreDirectionalSetup\b/);
  });
});

describe("V2.2's gates run before V1's rule", () => {
  it("refuses a frozen tape even though V1 would have proposed", () => {
    /*
     * The divergence that is the point of the exercise. V1 has no tape-liveness gate: D3 found 52
     * refused control points in one minute on 2026-09-01 and 41 proposals already stored at prices
     * nobody was quoting. Porting the entry rule must not port that.
     */
    const context = shortContext();
    const live = portedV1ThesisProducer({ context, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    const frozen = live.produce(gateFor(context, { tapeLiveness: "FROZEN" }));
    const flowing = live.produce(gateFor(context));

    expect(frozen.outcome).toBe("REJECTED");
    expect(frozen.outcome === "REJECTED" && frozen.reasons).toEqual(["TAPE_FROZEN"]);
    // Same bar, same rule: the only difference is the gate, so the pair proves the gate is what bound.
    expect(flowing.outcome).toBe("APPROVED");
  });

  it("defers when the pattern layer has not been computed", () => {
    const context = shortContext();
    const producer = portedV1ThesisProducer({ context, instrumentSymbol: "NIFTY50", strategies: indexOnly });
    const gate = gateFor(context);
    const uncovered: ThesisGateInput = {
      ...gate,
      snapshot: { ...gate.snapshot, patternCoverage: "NOT_LOADED" },
    };

    expect(producer.produce(uncovered).outcome).toBe("DEFERRED");
  });

  it("refuses outside the executable window", () => {
    const context = shortContext();
    const producer = portedV1ThesisProducer({ context, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    const result = producer.produce(gateFor(context, { insideExecutableWindow: false }));

    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["OUTSIDE_EXECUTABLE_WINDOW"]);
  });
});

describe("what it does with V1's proposals", () => {
  it("carries the geometry across unchanged, so a divergence means a platform defect", () => {
    /*
     * The migration claim. V1's own tick rounding has already run, so the thesis must reproduce those
     * numbers exactly -- a second rounding policy here would show up in P13 as a disagreement about
     * price and be mistaken for a sealing or feature bug.
     */
    const context = shortContext();
    const expected = new MomentumScalpIndexStrategy()
      .evaluate(context, indexOnly[0]!.registration.configuration)[0]!;
    const producer = portedV1ThesisProducer({ context, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    const result = producer.produce(gateFor(context));

    expect(result.outcome).toBe("APPROVED");
    if (result.outcome !== "APPROVED") throw new Error("unreachable");
    expect(result.value.side).toBe("SHORT");
    expect(result.value.entryReference).toBe(expected.entryPrice);
    expect(result.value.stopLoss).toBe(expected.stopLoss);
    expect(result.value.targetPrice).toBe(expected.targetPrice);
  });

  it("attributes the thesis to the V1 rule, not to V2.2", () => {
    /*
     * The misattribution this migration exists to avoid. A ported rule's outcomes must be recorded
     * against `momentum-scalp-index:v1`, or V1's losses would accrue to the new architecture and the
     * evidence for retiring V1 would be contaminated by the rule it carried over.
     */
    const context = shortContext();
    const producer = portedV1ThesisProducer({ context, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    const result = producer.produce(gateFor(context));

    if (result.outcome !== "APPROVED") throw new Error("expected an approval");
    expect(result.value.ruleId).toBe("momentum-scalp-index:v1");
    expect(result.value.policyVersion).toBe(portedV1PolicyVersion);
  });

  it("refuses to choose between two different proposals", () => {
    /*
     * Selection is the one thing an adapter may not do. Ranking by confidence is
     * `scoreDirectionalSetup` rebuilt and taking the first is `patterns[0]`; both are quarantined by
     * name. I3's Opportunity Resolver is the component entitled to choose, and it does not exist, so
     * the honest answer is a named refusal rather than a quiet pick.
     */
    const context = shortContext();
    const producer = portedV1ThesisProducer({
      context, instrumentSymbol: "NIFTY50",
      strategies: [stubStrategy("a", { stopLoss: 23_890 }), stubStrategy("b", { stopLoss: 23_895 })],
    });

    const result = producer.produce(gateFor(context));

    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["AMBIGUOUS_PROPOSALS"]);
  });

  it("treats identical geometry from two strategies as one decision", () => {
    // Two rules agreeing is not a choice to make. Refusing it as ambiguous would discard a bar where
    // V1 plainly acted, and P13 would lose exactly the decisive comparisons it needs.
    const context = shortContext();
    const producer = portedV1ThesisProducer({
      context, instrumentSymbol: "NIFTY50",
      strategies: [stubStrategy("a", {}), stubStrategy("b", {})],
    });

    expect(producer.produce(gateFor(context)).outcome).toBe("APPROVED");
  });

  it("distinguishes 'a rule declined' from 'we own no rule'", () => {
    /*
     * Both mean no trade, and they are different facts. `NO_ESTABLISHED_ENTRY_RULE` as an abstention
     * is V2.2 having no rule at all; a rejection carrying the same reason is a ported rule that ran
     * and said no. Collapsing them would make the ported producer indistinguishable from the native
     * one in precisely the runs where P13 has to tell them apart.
     */
    const flat = shortContext();
    const producer = portedV1ThesisProducer({
      context: flat, instrumentSymbol: "NIFTY50",
      strategies: [stubStrategy("none", {})].map((strategy) => ({
        ...strategy,
        StrategyClass: class { evaluate(): ProposedTradeIdea[] { return []; } },
      })) as unknown as readonly RegisteredStrategy[],
    });

    const ported = producer.produce(gateFor(flat));
    const native = nativeStructuralProducer.produce(gateFor(flat));

    expect(ported.outcome).toBe("REJECTED");
    expect(native.outcome).toBe("NO_ACTION");
  });

  it("drops a proposal on a side the registry no longer permits", () => {
    // The long side is -Rs 13,414 over 62 trades on this strategy. A LONG appearing here as a
    // decision "V1 made" would be a decision V1 could not have executed.
    const context = shortContext();
    const producer = portedV1ThesisProducer({
      context, instrumentSymbol: "NIFTY50",
      strategies: [stubStrategy("long-only", { side: "LONG", stopLoss: 23_830, targetPrice: 23_905 })],
    });

    const result = producer.produce(gateFor(context));

    expect(result.outcome).toBe("REJECTED");
    expect(result.outcome === "REJECTED" && result.reasons).toEqual(["NO_ESTABLISHED_ENTRY_RULE"]);
  });
});

describe("it refuses to compare two versions of one bar", () => {
  it("throws when the legacy context is not the one the snapshot was sealed from", () => {
    /*
     * The caller must pass the same in-memory context the snapshot came from. A context re-read for
     * the same bar is not the same thing -- contexts are enriched as pattern layers backfill -- and a
     * rebuild from the snapshot is thinner still, since `MarketSnapshot` drops `contextCandleIds` and
     * pattern details. Either would hand V1 a different world and make the divergence meaningless.
     */
    const sealed = shortContext();
    const other = shortContext({ closeTime: new Date("2026-09-02T09:30:00.000Z") });
    const producer = portedV1ThesisProducer({ context: other, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    expect(() => producer.produce(gateFor(sealed))).toThrow(V22ThesisBridgeError);
    expect(() => producer.produce(gateFor(sealed))).toThrow(/different bars/);
  });

  it("throws when the bar was revised under the same timestamp", () => {
    // Same instant, different close. This system has seen bars revised in place, and comparing two
    // versions of one bar would attribute a data correction to the platform.
    const sealed = shortContext();
    const revised = shortContext({ close: 23_855 });
    const producer = portedV1ThesisProducer({ context: revised, instrumentSymbol: "NIFTY50", strategies: indexOnly });

    expect(() => producer.produce(gateFor(sealed))).toThrow(/revised/);
  });
});
