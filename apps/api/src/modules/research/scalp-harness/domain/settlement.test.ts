import { describe, expect, it } from "vitest";
import type { ResearchGeometry, ResearchPriceCandle } from "./contracts.js";
import { canonicalOutcomeR, nativeOutcomeR, settleResearchPath } from "./settlement.js";

const decisionAt = new Date("2026-08-21T04:30:00.000Z");
const sessionCloseAt = new Date(decisionAt.getTime() + 120 * 60_000);

function geometry(overrides: Partial<ResearchGeometry> = {}): ResearchGeometry {
  return {
    direction: "LONG", entryOrderType: "MARKET_AT_REFERENCE", entryPrice: 100,
    stopLoss: 99, targetPrice: 101.5, expiresAt: new Date(decisionAt.getTime() + 60 * 60_000),
    geometryPolicyVersion: "TEST_GEOMETRY_V1", ...overrides,
  };
}

function candle(minute: number, values: Partial<Pick<ResearchPriceCandle, "open" | "high" | "low" | "close">> = {}): ResearchPriceCandle {
  const open = values.open ?? 100;
  const close = values.close ?? open;
  return {
    openTime: new Date(decisionAt.getTime() + (minute - 1) * 60_000),
    closeTime: new Date(decisionAt.getTime() + minute * 60_000),
    open,
    high: values.high ?? Math.max(open, close),
    low: values.low ?? Math.min(open, close),
    close,
  };
}

function settle(path: readonly ResearchPriceCandle[], customGeometry = geometry(), close = sessionCloseAt) {
  return settleResearchPath({
    subjectType: "CANONICAL_OPPORTUNITY", subjectId: "subject", geometry: customGeometry,
    decisionAt, sessionCloseAt: close, forwardCandles: path,
  });
}

describe("V1.3.1 shadow settlement", () => {
  it("resolves a normal target and keeps a pre-active single touch unambiguous", () => {
    const result = settle([candle(1, { high: 102, low: 99.5, close: 101.5 })]);
    expect(result.terminal).toMatchObject({ outcome: "TARGET", exitFillPrice: 101.5, rMultiple: 1.5 });
    expect(result.observations[0]).toMatchObject({ status: "ELIGIBLE_COMPLETE", targetTouchedByHorizon: true, stopTouchedByHorizon: false });
  });

  it("marks stop/target ordering in one active candle ambiguous", () => {
    expect(settle([candle(1, { high: 102, low: 98 })]).terminal).toMatchObject({
      outcome: "AMBIGUOUS", outcomeReason: "STOP_TARGET_INTRABAR_ORDER_UNKNOWN",
    });
  });

  it("marks entry plus a barrier in the trigger candle ambiguous", () => {
    const native = geometry({ entryOrderType: "LIMIT", entryPrice: 99, stopLoss: 98, targetPrice: 101 });
    expect(settle([candle(1, { open: 100, high: 101.5, low: 98.5, close: 100 })], native).terminal)
      .toMatchObject({ outcome: "AMBIGUOUS", entryFillCondition: "AT_LEVEL" });
  });

  it("uses the gap open for stops and prohibits positive target slippage", () => {
    const stop = settle([candle(1, { open: 98.5, high: 98.8, low: 98, close: 98.4 })]).terminal;
    expect(stop).toMatchObject({ outcome: "STOP", exitFillCondition: "GAP_THROUGH_STOP", exitFillPrice: 98.5 });
    const target = settle([candle(1, { open: 102, high: 102.5, low: 101.8, close: 102 })]).terminal;
    expect(target).toMatchObject({ outcome: "TARGET", exitFillCondition: "GAP_THROUGH_TARGET", exitFillPrice: 101.5 });
  });

  it("distinguishes a complete timeout from missing data", () => {
    const complete = Array.from({ length: 60 }, (_, index) => candle(index + 1));
    const timeout = settle(complete).terminal!;
    expect(timeout).toMatchObject({ outcome: "TIMEOUT", exitFillCondition: "TIMEOUT_CLOSE", rMultiple: 0 });
    expect(canonicalOutcomeR(timeout)).toBe(0);

    const incomplete = settle(complete.slice(0, 2)).terminal!;
    expect(incomplete).toMatchObject({ outcome: "DATA_INCOMPLETE", outcomeReason: "MISSING_1M_CANDLE" });
    expect(canonicalOutcomeR(incomplete)).toBeNull();
  });

  it("does not manufacture a cross-session timeout", () => {
    const close = new Date(decisionAt.getTime() + 30 * 60_000);
    const result = settle([], geometry(), close);
    expect(result.terminal).toBeNull();
    expect(result.observations.find((item) => item.horizonMinutes === 60)).toMatchObject({
      horizonEligible: false, status: "INELIGIBLE_SESSION_BOUNDARY", statusReason: "SESSION_BOUNDARY",
    });
  });

  it("keeps intent-to-trade and conditional-on-entry distinct", () => {
    const native = geometry({ entryOrderType: "LIMIT", entryPrice: 95, stopLoss: 94, targetPrice: 96.5 });
    const result = settle(Array.from({ length: 60 }, (_, index) => candle(index + 1)), native).terminal!;
    expect(result.outcome).toBe("ENTRY_NOT_TRIGGERED");
    expect(nativeOutcomeR(result, "INTENT_TO_TRADE")).toBe(0);
    expect(nativeOutcomeR(result, "CONDITIONAL_ON_ENTRY")).toBeNull();
  });

  it("records invalid policy as an engineering terminal without walking malformed geometry", () => {
    const result = settle([], geometry({ stopLoss: 101 }));
    expect(result.terminal?.outcome).toBe("POLICY_INVALID");
    expect(result.observations[0]?.statusReason).toBe("POLICY_INVALID");
  });
});
