import { describe, expect, it } from "vitest";
import { describeStrategyFailures, type StrategyFailure } from "./strategy-failure-report.js";

const failure = (overrides: Partial<StrategyFailure> = {}): StrategyFailure => ({
  bot: "AutoBot-IctBankNifty5m",
  symbol: "BANKNIFTY",
  timeframe: "5m",
  strategy: "ict-structure-v1",
  message: "params.confirmationCandleTime.toISOString is not a function",
  ...overrides,
});

describe("describeStrategyFailures", () => {
  it("says nothing when no strategy threw", () => {
    expect(describeStrategyFailures([])).toBeNull();
  });

  it("names the strategy, the series, the bot and the actual error", () => {
    const text = describeStrategyFailures([failure()])!;
    expect(text).toContain("1 strategy evaluation(s) threw");
    expect(text).toContain("ict-structure-v1 on BANKNIFTY 5m");
    expect(text).toContain("toISOString is not a function");
    expect(text).toContain("AutoBot-IctBankNifty5m");
  });

  it("reports the same failure seen by two bots once, listing both", () => {
    const text = describeStrategyFailures([failure({ bot: "AutoBot-A" }), failure({ bot: "AutoBot-B" })])!;
    expect(text).toContain("1 strategy evaluation(s) threw");
    expect(text).toContain("AutoBot-A, AutoBot-B");
  });

  it("keeps different failures, and different series, apart", () => {
    const text = describeStrategyFailures([failure(), failure({ timeframe: "15m" }), failure({ message: "other" })])!;
    expect(text).toContain("3 strategy evaluation(s) threw");
  });

  it("caps the list so the cause is not pushed out of the stored tail", () => {
    const many = Array.from({ length: 9 }, (_, index) => failure({ symbol: `S${index}` }));
    const text = describeStrategyFailures(many)!;
    expect(text).toContain("9 strategy evaluation(s) threw");
    expect(text).toContain("and 4 more");
    expect(text).toContain("S4");
    expect(text).not.toContain("S5");
  });

  it("clips a very long message and collapses its whitespace", () => {
    const text = describeStrategyFailures([failure({ message: `bad\n   value ${"x".repeat(1000)}` })])!;
    expect(text).toContain("bad value ");
    expect(text.length).toBeLessThan(700);
  });

  it("copes with a failure that carried no message", () => {
    expect(describeStrategyFailures([failure({ message: null })])).toContain("no message");
  });
});
