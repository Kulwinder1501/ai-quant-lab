import { describe, expect, it } from "vitest";
import { formatIctGateLine, summariseIctGates, type IctGateBar } from "./ict-gate-report.js";

const bar = (alignmentStatus: string, biasDirection = "BEARISH"): IctGateBar => ({ alignmentStatus, biasDirection });
const repeat = (n: number, item: IctGateBar): IctGateBar[] => Array.from({ length: n }, () => item);

describe("summariseIctGates", () => {
  // 2026-10-14 on NIFTY 15m: a bearish daily bias against a bullish bounce.
  const day = [
    ...repeat(16, bar("BLOCKED_BIAS_STRUCTURE_DISAGREEMENT")),
    ...repeat(6, bar("BLOCKED_DISCOUNT_SHORT")),
    ...repeat(3, bar("ALIGNED_SHORT")),
  ];

  it("counts blocked bars by reason, largest first, and names the top blocker", () => {
    const summary = summariseIctGates(day, { ideas: 0, trades: 0 });
    expect(summary.bars).toBe(25);
    expect(summary.alignedBars).toBe(3);
    expect(summary.blocked).toEqual([
      { status: "BLOCKED_BIAS_STRUCTURE_DISAGREEMENT", bars: 16 },
      { status: "BLOCKED_DISCOUNT_SHORT", bars: 6 },
    ]);
    expect(summary.topBlocker).toBe("BLOCKED_BIAS_STRUCTURE_DISAGREEMENT");
    expect(summary.bias).toBe("BEARISH");
  });

  it("does not count an aligned bar as a blocker, long or short", () => {
    const summary = summariseIctGates([bar("ALIGNED_LONG", "BULLISH"), bar("ALIGNED_SHORT")], { ideas: 1, trades: 1 });
    expect(summary.blocked).toEqual([]);
    expect(summary.topBlocker).toBeNull();
    expect(summary.alignedBars).toBe(2);
  });

  it("breaks a tie between blockers alphabetically so the line is stable", () => {
    const summary = summariseIctGates(
      [bar("BLOCKED_PREMIUM_LONG"), bar("BLOCKED_DISCOUNT_SHORT")],
      { ideas: 0, trades: 0 },
    );
    expect(summary.topBlocker).toBe("BLOCKED_DISCOUNT_SHORT");
  });

  it("handles a day with no bars", () => {
    const summary = summariseIctGates([], { ideas: 0, trades: 0 });
    expect(summary.bars).toBe(0);
    expect(summary.bias).toBeNull();
    expect(summary.topBlocker).toBeNull();
  });
});

describe("formatIctGateLine", () => {
  it("states the day in one line, with the share each gate blocked", () => {
    const summary = summariseIctGates(
      [
        ...repeat(16, bar("BLOCKED_BIAS_STRUCTURE_DISAGREEMENT")),
        ...repeat(6, bar("BLOCKED_DISCOUNT_SHORT")),
        ...repeat(3, bar("ALIGNED_SHORT")),
      ],
      { ideas: 0, trades: 0 },
    );
    expect(formatIctGateLine("2026-10-14", "NIFTY50/15m", summary)).toBe(
      "ICT 2026-10-14 NIFTY50/15m: 25 bars, bias BEARISH | mostly blocked: bias and structure disagree | "
      + "64% bias and structure disagree, 24% already in discount (no short), 12% aligned (setup trigger not met) | ideas 0, trades 0",
    );
  });

  // 2026-10-13 on NIFTY 15m: the pillars agreed on 68% of bars, so no gate explains the quiet day -- the setup did.
  it("says the trigger did not fire when aligned bars outnumber any single blocker", () => {
    const summary = summariseIctGates(
      [...repeat(17, bar("ALIGNED_SHORT")), ...repeat(4, bar("BLOCKED_BIAS_STRUCTURE_DISAGREEMENT")), ...repeat(4, bar("BLOCKED_DISCOUNT_SHORT"))],
      { ideas: 0, trades: 0 },
    );
    const line = formatIctGateLine("2026-10-13", "NIFTY50/15m", summary);
    expect(line).toContain("mostly aligned: the setup trigger did not fire");
    expect(line).not.toContain("mostly blocked");
  });

  it("says so when the day has no bars rather than printing zero percentages", () => {
    const line = formatIctGateLine("2026-10-15", "BANKNIFTY/5m", summariseIctGates([], { ideas: 0, trades: 0 }));
    expect(line).toContain("no bars recorded");
  });

  it("reports a day where every bar was aligned without inventing a blocker", () => {
    const summary = summariseIctGates(repeat(4, bar("ALIGNED_SHORT")), { ideas: 0, trades: 0 });
    const line = formatIctGateLine("2026-10-14", "BANKNIFTY/5m", summary);
    expect(line).toContain("every bar was aligned");
    expect(line).toContain("100% aligned");
  });
});
