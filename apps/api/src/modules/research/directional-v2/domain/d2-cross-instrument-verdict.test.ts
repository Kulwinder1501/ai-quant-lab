import { describe, expect, it } from "vitest";
import {
  D2_REQUIRED_QUALIFIED_SESSIONS,
  resolveD2CrossInstrumentVerdict,
  type D2InstrumentOutcome,
} from "./d2-cross-instrument-verdict.js";

function outcome(overrides: Partial<D2InstrumentOutcome> & { underlyingSymbol: string }): D2InstrumentOutcome {
  return { verdict: "PASS", qualifiedSessionCount: D2_REQUIRED_QUALIFIED_SESSIONS, ...overrides };
}

const qualified = (symbol: string, verdict: D2InstrumentOutcome["verdict"]) =>
  outcome({ underlyingSymbol: symbol, verdict });

describe("D2 cross-instrument verdict", () => {
  it("passes only when both indices clear the gate, and says what the pass does not mean", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "PASS"),
      qualified("BANKNIFTY", "PASS"),
    ]);

    expect(decision.verdict).toBe("CROSS_INSTRUMENT_PASS");
    expect(decision.mayProgress).toBe(true);
    // Section 8.1: the frozen candidate emits no UP signals at all, so a PASS is one-sided.
    expect(decision.reasons.join(" ")).toMatch(/does not establish bidirectional/);
  });

  it("reports one-pass-one-fail as DRIFT, not FAIL", () => {
    // The defect this replaces. The previous rule was `if (some FAIL) return "FAIL"`, which
    // collapsed drift into a plain failure and silently discarded the obligation to require a new
    // hypothesis rather than trading the instrument that worked.
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "PASS"),
      qualified("BANKNIFTY", "FAIL"),
    ]);

    expect(decision.verdict).toBe("CROSS_INSTRUMENT_DRIFT");
    expect(decision.mayProgress).toBe(false);
    expect(decision.reasons.join(" ")).toMatch(/never means trade the instrument that worked/);
  });

  it("is symmetric about which instrument passed", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "FAIL"),
      qualified("BANKNIFTY", "PASS"),
    ]);

    expect(decision.verdict).toBe("CROSS_INSTRUMENT_DRIFT");
  });

  it("fails only when neither index clears, and says what the failure does not mean", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "FAIL"),
      qualified("BANKNIFTY", "FAIL"),
    ]);

    expect(decision.verdict).toBe("FAIL");
    expect(decision.reasons.join(" ")).toMatch(/does not establish that directional trading is impossible/);
  });

  it("returns INSUFFICIENT_VALID_DATA when qualified sessions fall short, without reading the gate verdicts", () => {
    // Both instruments "FAIL" here, but the test was never validly obtained, so publishing FAIL
    // would assert a directional claim the data cannot carry.
    const decision = resolveD2CrossInstrumentVerdict([
      outcome({ underlyingSymbol: "NIFTY50", verdict: "FAIL", qualifiedSessionCount: 9 }),
      outcome({ underlyingSymbol: "BANKNIFTY", verdict: "FAIL", qualifiedSessionCount: 9 }),
    ]);

    expect(decision.verdict).toBe("INSUFFICIENT_VALID_DATA");
    expect(decision.reasons.join(" ")).toMatch(/carries no directional information/);
  });

  it("does not let a passing instrument mask the other's short qualification", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "PASS"),
      outcome({ underlyingSymbol: "BANKNIFTY", verdict: "PASS", qualifiedSessionCount: 59 }),
    ]);

    expect(decision.verdict).toBe("INSUFFICIENT_VALID_DATA");
    expect(decision.reasons.join(" ")).toMatch(/BANKNIFTY has 59 qualified sessions/);
  });

  it("treats a per-instrument INSUFFICIENT_DATA as an absent test, not a lost one", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "PASS"),
      qualified("BANKNIFTY", "INSUFFICIENT_DATA"),
    ]);

    expect(decision.verdict).toBe("INSUFFICIENT_VALID_DATA");
  });

  it("accepts exactly 60 qualified sessions as sufficient", () => {
    const decision = resolveD2CrossInstrumentVerdict([
      outcome({ underlyingSymbol: "NIFTY50", verdict: "PASS", qualifiedSessionCount: 60 }),
      outcome({ underlyingSymbol: "BANKNIFTY", verdict: "PASS", qualifiedSessionCount: 60 }),
    ]);

    expect(decision.verdict).toBe("CROSS_INSTRUMENT_PASS");
  });

  it("refuses to render a verdict from a partial instrument set", () => {
    // Dropping an index and reporting the survivor is exactly the single-instrument rescue the
    // drift branch exists to prevent, so it must not be reachable by omission either.
    expect(() => resolveD2CrossInstrumentVerdict([qualified("NIFTY50", "PASS")]))
      .toThrow(/requires BANKNIFTY/);
    expect(() => resolveD2CrossInstrumentVerdict([
      qualified("NIFTY50", "PASS"),
      qualified("BANKNIFTY", "PASS"),
      qualified("FINNIFTY", "PASS"),
    ])).toThrow(/exactly 2 instruments/);
  });
});
