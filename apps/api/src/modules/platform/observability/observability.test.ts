import { describe, expect, it } from "vitest";
import {
  classifyTick,
  DEFERRAL_FAMILIES,
  parseDeferralReason,
  UnknownDeferralFamilyError,
  type DecisionAuditRecord,
} from "./decision-audit-record.js";
import { evaluateThreshold, findThreshold, OBS_POLICY_V1 } from "./observability-policy.js";
import { controlIneligibleReason } from "../../research/scalp-harness/domain/research-strategies.js";
import type { StrategyMarketContext } from "../../strategy-engine/domain/strategy.js";

const decisionAt = new Date("2026-08-31T09:46:00.000Z");

function record(overrides: Partial<DecisionAuditRecord> = {}): DecisionAuditRecord {
  return {
    decisionId: "decision-1",
    symbol: "NIFTY50",
    decisionAt,
    evaluationAt: new Date(decisionAt.getTime() + 8_000),
    schedulerLagMs: 8_000,
    snapshotResult: "RESOLVED",
    snapshotRef: "a".repeat(64),
    deferral: null,
    strategyEvaluationStatus: "EVALUATED",
    candidateCount: 0,
    candidateIds: [],
    admissionResult: "NO_CANDIDATE",
    riskResult: null,
    riskRejectionInvariant: null,
    executionResult: null,
    ...overrides,
  };
}

describe("deferral taxonomy is the research one, not a parallel set", () => {
  it("accepts every reason string the harness actually emits", () => {
    /*
     * The cross-check that keeps the two vocabularies from drifting.
     *
     * `controlIneligibleReason` is the live producer, so its output is the ground truth for what
     * production must be able to record. Asserting against hand-written literals would pass happily
     * while the harness emitted something else -- which is exactly how the specification ended up
     * listing `DEFERRED_FEATURE_WARMUP` for a code that is really `FEATURE_WARMUP:ATR,EMA`.
     */
    const bareContext = { candle: { timeframe: "1m" }, indicators: [], patterns: [], priceActionEvents: [] } as unknown as StrategyMarketContext;

    const emitted = [
      controlIneligibleReason(bareContext, "COMPLETE", "FROZEN"),
      controlIneligibleReason(bareContext, "COMPLETE", "LIVE"),
      controlIneligibleReason(bareContext, "INCOMPLETE", "LIVE"),
    ].filter((reason): reason is string => reason !== null);

    expect(emitted.length).toBe(3);
    for (const reason of emitted) {
      expect(() => parseDeferralReason(reason), reason).not.toThrow();
    }
    // And specifically: the warmup code arrives with its payload intact.
    const warmup = emitted.find((reason) => reason.startsWith("FEATURE_WARMUP"));
    expect(parseDeferralReason(warmup!)).toEqual({
      family: "FEATURE_WARMUP",
      payload: "ATR,EMA,EMA,RSI,SUPERTREND,VWAP",
      raw: warmup,
    });
  });

  it("keeps the payload that says which inputs were missing", () => {
    // The detail a flat `DEFERRED_FEATURE_WARMUP` would have destroyed. The harness abandoned an
    // ATR-only eligibility check precisely because a coarse flag hid which feature was absent.
    expect(parseDeferralReason("FEATURE_WARMUP:ATR,VWAP").payload).toBe("ATR,VWAP");
    expect(parseDeferralReason("TAPE_FROZEN").payload).toBeNull();
  });

  it("splits on the first colon only, so a payload may contain colons", () => {
    expect(parseDeferralReason("FEATURE_WARMUP:EMA:3,EMA:8").payload).toBe("EMA:3,EMA:8");
  });

  it("refuses an undeclared family rather than recording it", () => {
    // The rule the specification stated and its own field list broke. A code nobody declared cannot
    // be aggregated or compared against research, so it must fail loudly at the boundary.
    expect(() => parseDeferralReason("DEFERRED_FEATURE_WARMUP")).toThrow(UnknownDeferralFamilyError);
    expect(() => parseDeferralReason("DEFERRED_FEATURE_NOT_COMPUTED")).toThrow(/not a declared deferral family/);
    expect(() => parseDeferralReason("SOMETHING_NEW:x")).toThrow(UnknownDeferralFamilyError);
  });

  it("refuses a blank reason and a trailing colon with no payload", () => {
    expect(() => parseDeferralReason("   ")).toThrow(/cannot be blank/);
    // Claims a payload and supplies none, which reads as "nothing was missing".
    expect(() => parseDeferralReason("FEATURE_WARMUP:")).toThrow(/trailing colon/);
  });

  it("declares the tape state the specification omitted", () => {
    expect(DEFERRAL_FAMILIES).toContain("TAPE_FROZEN");
    // And the production-only family, which has no harness counterpart because the harness throws
    // on an off-grid decision rather than deferring.
    expect(DEFERRAL_FAMILIES).toContain("GRID_MISALIGNED");
  });
});

describe("classifyTick makes every tick classifiable", () => {
  it("resolves each stage of the funnel to a distinct outcome", () => {
    expect(classifyTick(record({
      deferral: parseDeferralReason("TAPE_FROZEN"), strategyEvaluationStatus: "SKIPPED",
    }))).toBe("DEFERRED_BEFORE_STRATEGY");

    expect(classifyTick(record({
      snapshotResult: "UNAVAILABLE", strategyEvaluationStatus: "SKIPPED",
    }))).toBe("DEFERRED_BEFORE_STRATEGY");

    expect(classifyTick(record({ strategyEvaluationStatus: "INELIGIBLE" }))).toBe("STRATEGY_NOT_RUN");
    expect(classifyTick(record())).toBe("NO_CANDIDATE");

    expect(classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "REJECTED",
    }))).toBe("REJECTED_BY_ADMISSION");

    expect(classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "APPROVED", riskResult: "REJECTED",
      riskRejectionInvariant: "I5_EXPOSURE_LIMIT",
    }))).toBe("REJECTED_BY_RISK");

    expect(classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "APPROVED", riskResult: "APPROVED",
      executionResult: "EXECUTED",
    }))).toBe("EXECUTED");

    expect(classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "APPROVED", riskResult: "APPROVED",
      executionResult: "NO_ACTION",
    }))).toBe("NO_ACTION_AFTER_APPROVAL");
  });

  it("distinguishes strategy-never-ran from strategy-ran-and-found-nothing", () => {
    /*
     * The distinction the whole record exists for. Both produce zero trades and, without these two
     * fields, both look like a quiet market. One is a pipeline defect.
     */
    expect(classifyTick(record({ strategyEvaluationStatus: "SKIPPED" }))).toBe("STRATEGY_NOT_RUN");
    expect(classifyTick(record({ strategyEvaluationStatus: "EVALUATED", candidateCount: 0 })))
      .toBe("NO_CANDIDATE");
  });

  it("separates NO_ACTION after approval from every other zero-trade tick", () => {
    // "No silent NO_ACTION": a tick that got all the way through risk and still did nothing is a
    // distinct, reportable state, not the same as a bar that never produced a candidate.
    const outcomes = new Set([
      classifyTick(record()),
      classifyTick(record({ strategyEvaluationStatus: "SKIPPED" })),
      classifyTick(record({
        candidateCount: 1, candidateIds: ["p1"], admissionResult: "APPROVED",
        riskResult: "APPROVED", executionResult: "NO_ACTION",
      })),
    ]);

    expect(outcomes.size).toBe(3);
  });

  it("throws on a record that contradicts itself rather than picking a story", () => {
    // A schema hole must surface here, not as an unexplained quiet tick months later.
    expect(() => classifyTick(record({
      deferral: parseDeferralReason("TAPE_FROZEN"), strategyEvaluationStatus: "EVALUATED",
    }))).toThrow(/disagrees with itself/);

    expect(() => classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "NO_CANDIDATE",
    }))).toThrow(/NO_CANDIDATE admission/);

    expect(() => classifyTick(record({
      candidateCount: 0, admissionResult: "APPROVED",
    }))).toThrow(/cannot have judged something that does not exist/);

    expect(() => classifyTick(record({
      candidateCount: 2, candidateIds: ["p1"], admissionResult: "APPROVED", riskResult: "APPROVED",
    }))).toThrow(/2 candidates but 1 ids/);

    // An approved candidate with no risk result would hide a bypassed gate (I17).
    expect(() => classifyTick(record({
      candidateCount: 1, candidateIds: ["p1"], admissionResult: "APPROVED", riskResult: null,
    }))).toThrow(/risk is not optional/i);
  });

  it("treats scheduler lag as telemetry that never moves decisionAt", () => {
    const late = record({ evaluationAt: new Date(decisionAt.getTime() + 45_000), schedulerLagMs: 45_000 });

    expect(late.decisionAt.toISOString()).toBe(decisionAt.toISOString());
    expect(classifyTick(late)).toBe("NO_CANDIDATE");
  });
});

describe("ObservabilityPolicy", () => {
  it("declares metrics without guessing thresholds", () => {
    /*
     * A guessed threshold produces the failure that makes monitoring worthless: an alert that fires
     * often enough to be ignored, after which a real one is invisible too. Null is "declared,
     * deliberately unset", which is a different state from omitted.
     */
    expect(findThreshold(OBS_POLICY_V1, "data_ready_gate.defer_rate")?.threshold).toBeNull();
    expect(evaluateThreshold({
      policy: OBS_POLICY_V1, metric: "data_ready_gate.defer_rate", observed: 0.9,
    })).toBe("NOT_EVALUATED");
  });

  it("keeps NOT_EVALUATED distinct from OK", () => {
    // Collapsing them makes "we have not set a bar" indistinguishable from "this is within bounds".
    const unset = evaluateThreshold({ policy: OBS_POLICY_V1, metric: "risk_engine.rejection_rate", observed: 1 });
    const withinBounds = evaluateThreshold({
      policy: OBS_POLICY_V1, metric: "tape_liveness.frozen_decisions_per_session", observed: 13,
    });

    expect(unset).toBe("NOT_EVALUATED");
    expect(withinBounds).toBe("OK");
    expect(unset).not.toBe(withinBounds);
  });

  it("alerts on the two thresholds that are derived rather than chosen", () => {
    // Zero fills during market hours means the pipeline is down, whatever the strategy.
    expect(evaluateThreshold({ policy: OBS_POLICY_V1, metric: "execution.fill_rate", observed: 0 }))
      .toBe("BREACHED");
    expect(evaluateThreshold({ policy: OBS_POLICY_V1, metric: "execution.fill_rate", observed: 0.4 }))
      .toBe("OK");

    // 13 frozen decisions per instrument per session is the measured floor from the close freeze;
    // materially more means the feed stalled intraday.
    expect(evaluateThreshold({
      policy: OBS_POLICY_V1, metric: "tape_liveness.frozen_decisions_per_session", observed: 40,
    })).toBe("BREACHED");
  });

  it("throws for an undeclared metric instead of reporting it healthy", () => {
    // A green light with nothing behind it is worse than no dashboard.
    expect(() => evaluateThreshold({ policy: OBS_POLICY_V1, metric: "made.up.metric", observed: 0 }))
      .toThrow(/not declared in OBS_POLICY_V1/);
  });

  it("refuses a non-finite observation", () => {
    expect(() => evaluateThreshold({
      policy: OBS_POLICY_V1, metric: "execution.fill_rate", observed: Number.NaN,
    })).toThrow(/must be finite/);
  });
});
