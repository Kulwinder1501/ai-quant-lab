import { describe, expect, it } from "vitest";
import { parseNonNegativeNumber, parseOptionalNonNegativeNumber } from "./paper-trading-arguments.js";

/**
 * The distinction between "the caller said zero" and "the caller said nothing".
 *
 * It is load-bearing for exit fees only. `EvaluateOpenPaperTrades` computes them when the value is
 * undefined and honours it when supplied, and `??` treats 0 as supplied -- so coercing an absent
 * flag to 0 silently switched brokerage off. Slippage has no computed alternative, so 0 there is
 * the correct default and `parseNonNegativeNumber` stays right for it.
 */
describe("optional non-negative CLI numbers", () => {
  it("returns undefined when the flag is absent", () => {
    expect(parseOptionalNonNegativeNumber(undefined, "exit-fees")).toBeUndefined();
  });

  it("returns 0 when the flag is present and zero, which is a real instruction", () => {
    // "--exit-fees 0" means "this exit is free", and must stay distinguishable from silence.
    expect(parseOptionalNonNegativeNumber("0", "exit-fees")).toBe(0);
  });

  it("parses a supplied value", () => {
    expect(parseOptionalNonNegativeNumber("32.26", "exit-fees")).toBe(32.26);
  });

  it("still rejects a negative or unparseable value", () => {
    expect(() => parseOptionalNonNegativeNumber("-1", "exit-fees")).toThrow(/non-negative/);
    expect(() => parseOptionalNonNegativeNumber("abc", "exit-fees")).toThrow(/non-negative/);
  });

  it("contrasts with the coercing parser, which is what caused the defect", () => {
    // The old call site. Absent flag -> 0 -> "fees supplied, do not compute".
    expect(parseNonNegativeNumber(undefined, "exit-fees")).toBe(0);
  });
});
