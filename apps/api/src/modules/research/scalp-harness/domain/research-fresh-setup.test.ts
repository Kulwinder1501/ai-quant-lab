import { describe, expect, it } from "vitest";
import {
  FreshSetupResearchAdapter,
  createResearchScalpStrategies,
  type BaseEvaluator,
  type LegacyScoreGate,
} from "./research-strategies.js";
import { buildStrategyDefinition } from "./contracts.js";
import type { ProposedTradeIdea, StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";

/**
 * The V11 fresh-setup adapter, which shipped untested.
 *
 * Two properties matter and neither was covered: what it suppresses, and that its memory belongs to
 * one run rather than to the process. The second is the one that could corrupt data -- the adapter
 * array was a module-level constant, so `verify-live-backfill-parity` rebuilt proposals through the
 * same instances the capture path had already advanced.
 */

const definition = buildStrategyDefinition({
  strategyKey: "momentum-v11-research",
  researchVersion: 11,
  featureSchemaVersion: "scalp-raw-context-v4",
  implementationArtifactChecksum: "0".repeat(64),
  configuration: { minimumConfidence: 0 },
});

const gate: LegacyScoreGate = {
  parameter: "minimumConfidence",
  threshold: 0,
  value: (proposal) => proposal.confidence,
  maximum: () => 1,
};

function context(id: string, overrides: Partial<StrategyMarketContext["candle"]> = {}): StrategyMarketContext {
  return {
    candle: {
      id,
      instrumentId: "instrument-1",
      timeframe: "1m",
      openTime: new Date("2026-09-09T04:00:00.000Z"),
      closeTime: new Date("2026-09-09T04:01:00.000Z"),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1_000,
      tickSize: 0.05,
      ...overrides,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  };
}

class Stub implements BaseEvaluator {
  constructor(private side: "LONG" | "SHORT" | null) {}
  setSide(side: "LONG" | "SHORT" | null) { this.side = side; }
  evaluate(): ProposedTradeIdea[] {
    if (this.side === null) return [];
    return [{
      side: this.side,
      entryPrice: 100,
      stopLoss: this.side === "LONG" ? 99 : 101,
      targetPrice: this.side === "LONG" ? 102 : 98,
      riskReward: 2,
      confidence: 0.8,
      reasoning: ["stub"],
      evidence: {},
      // The adapter throws without a native expiry, deliberately, so the fixture supplies one.
      expiresAt: new Date("2026-09-09T04:05:00.000Z"),
      evidenceItems: [],
    }];
  }
}

function adapterFor(stub: Stub): FreshSetupResearchAdapter {
  return new FreshSetupResearchAdapter(definition, ["1m"], stub, "MOMENTUM_CONTINUATION", gate);
}

describe("FreshSetupResearchAdapter", () => {
  it("emits the first proposal and suppresses the same-side repeat", () => {
    const stub = new Stub("LONG");
    const adapter = adapterFor(stub);
    const first = context("c1");
    expect(adapter.evaluate(first, first)).toHaveLength(1);
    const second = context("c2");
    expect(adapter.evaluate(second, second)).toEqual([]);
  });

  it("emits on a direction change", () => {
    const stub = new Stub("LONG");
    const adapter = adapterFor(stub);
    const first = context("c1");
    expect(adapter.evaluate(first, first)).toHaveLength(1);
    stub.setSide("SHORT");
    const second = context("c2");
    expect(adapter.evaluate(second, second)).toHaveLength(1);
  });

  it("re-arms after a bar with no proposal", () => {
    const stub = new Stub("LONG");
    const adapter = adapterFor(stub);
    const first = context("c1");
    expect(adapter.evaluate(first, first)).toHaveLength(1);
    stub.setSide(null);
    const quiet = context("c2");
    expect(adapter.evaluate(quiet, quiet)).toEqual([]);
    stub.setSide("LONG");
    const third = context("c3");
    expect(adapter.evaluate(third, third)).toHaveLength(1);
  });

  it("records WHY the setup was fresh, not a constant true", () => {
    /*
     * `freshSetup.passed` was always true -- a suppressed bar returns before any row is built, so no
     * row could ever contradict it and the covariate carried no information. The two ways a setup
     * becomes fresh are different events and now say which.
     */
    const stub = new Stub("LONG");
    const adapter = adapterFor(stub);
    const first = context("c1");
    const opening = adapter.evaluate(first, first)[0];
    expect((opening.rawContext as { freshSetup: { reason: string } }).freshSetup.reason)
      .toBe("FIRST_PROPOSAL");

    stub.setSide("SHORT");
    const second = context("c2");
    const flipped = adapter.evaluate(second, second)[0];
    expect((flipped.rawContext as { freshSetup: { reason: string } }).freshSetup.reason)
      .toBe("DIRECTION_CHANGE");
  });

  it("refuses a timeframe it does not support instead of proposing on it", () => {
    const adapter = adapterFor(new Stub("LONG"));
    const fiveMinute = context("c1", { timeframe: "5m" });
    expect(adapter.evaluate(fiveMinute, context("c1"))).toEqual([]);
  });

  it("refuses when the strategy and reference contexts are different instruments", () => {
    const adapter = adapterFor(new Stub("LONG"));
    expect(() => adapter.evaluate(
      context("c1", { instrumentId: "instrument-1" }),
      context("c1", { instrumentId: "instrument-2" }),
    )).toThrow(/same instrument/);
  });

  it("keys its memory per series", () => {
    const adapter = adapterFor(new Stub("LONG"));
    const a = context("a1", { instrumentId: "instrument-1" });
    const b = context("b1", { instrumentId: "instrument-2" });
    expect(adapter.evaluate(a, a)).toHaveLength(1);
    expect(adapter.evaluate(b, b)).toHaveLength(1);
    const a2 = context("a2", { instrumentId: "instrument-1" });
    expect(adapter.evaluate(a2, a2)).toEqual([]);
  });
});

describe("createResearchScalpStrategies", () => {
  it("hands out independent adapters, so one run cannot inherit another's memory", () => {
    /*
     * The array used to be a module-level constant. Every consumer in a process shared one memory,
     * and because capture rows use KEEP_EXISTING on payload divergence a re-derivation judged against
     * foreign state would not throw -- it would silently keep the older row.
     */
    const first = createResearchScalpStrategies();
    const second = createResearchScalpStrategies();
    expect(first).not.toBe(second);

    const v11 = (set: readonly { definition: { strategyKey: string } }[]) =>
      set.find((adapter) => adapter.definition.strategyKey === "momentum-v11-research");
    expect(v11(first)).toBeDefined();
    expect(v11(first)).not.toBe(v11(second));
  });

  it("returns the same definitions each time, so only state is fresh", () => {
    const keysOf = (set: readonly { definition: { strategyDefinitionHash: string } }[]) =>
      set.map((adapter) => adapter.definition.strategyDefinitionHash);
    expect(keysOf(createResearchScalpStrategies())).toEqual(keysOf(createResearchScalpStrategies()));
  });
});
