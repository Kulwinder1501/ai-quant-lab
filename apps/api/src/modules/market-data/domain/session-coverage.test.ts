import { describe, expect, it } from "vitest";
import {
  assessSessionCoverage,
  formatSessionCoverageLine,
  type SessionCoverageInput,
} from "./session-coverage.js";

function healthy(): SessionCoverageInput {
  return {
    date: "2026-10-19",
    bars: [
      { symbol: "NIFTY50", timeframe: "1m", bars: 375 },
      { symbol: "NIFTY50", timeframe: "5m", bars: 75 },
      { symbol: "NIFTY50", timeframe: "15m", bars: 25 },
      { symbol: "NIFTY50", timeframe: "60m", bars: 6 },
      { symbol: "NIFTYBEES", timeframe: "5m", bars: 75 },
    ],
    chains: [
      { underlying: "NIFTY50", snapshots: 26, lastMinute: 15 * 60 + 23 },
      { underlying: "BANKNIFTY", snapshots: 26, lastMinute: 15 * 60 + 23 },
    ],
    ticks: [
      { underlying: "NIFTY50", minutesWithTicks: 372, lastMinute: 15 * 60 + 29 },
      { underlying: "BANKNIFTY", minutesWithTicks: 372, lastMinute: 15 * 60 + 29 },
    ],
    depthFrames: 44_000,
  };
}

describe("assessSessionCoverage", () => {
  it("passes a complete session", () => {
    const verdict = assessSessionCoverage(healthy());
    expect(verdict.ok).toBe(true);
    expect(verdict.issues).toEqual([]);
  });

  it("allows a few missing one-minute bars but not a missing five-minute one beyond one", () => {
    const input = healthy();
    input.bars = [
      { symbol: "NIFTY50", timeframe: "1m", bars: 371 },
      { symbol: "NIFTY50", timeframe: "5m", bars: 74 },
    ];
    expect(assessSessionCoverage(input).ok).toBe(true);

    input.bars = [
      { symbol: "NIFTY50", timeframe: "1m", bars: 369 },
      { symbol: "NIFTY50", timeframe: "5m", bars: 73 },
    ];
    const verdict = assessSessionCoverage(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.healable).toEqual(["NIFTY50 1m", "NIFTY50 5m"]);
  });

  it("flags the ETF series that stopped at 11:03 on 2026-10-16 as healable", () => {
    const input = healthy();
    input.bars = [{ symbol: "NIFTYBEES", timeframe: "1m", bars: 71 }, { symbol: "NIFTYBEES", timeframe: "5m", bars: 13 }];
    const verdict = assessSessionCoverage(input);
    expect(verdict.issues).toEqual([
      "NIFTYBEES 1m: 71 of 375 bars (304 missing)",
      "NIFTYBEES 5m: 13 of 75 bars (62 missing)",
    ]);
    expect(verdict.unrecoverable).toEqual([]);
  });

  it("flags a chain that stopped early and ticks that stopped at 12:04, and marks them unrecoverable", () => {
    const input = healthy();
    input.chains = [{ underlying: "BANKNIFTY", snapshots: 9, lastMinute: 10 * 60 + 53 }];
    input.ticks = [{ underlying: "BANKNIFTY", minutesWithTicks: 170, lastMinute: 12 * 60 + 4 }];

    const verdict = assessSessionCoverage(input);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues).toEqual([
      "BANKNIFTY option chain: 9 snapshots (need 20), last at 10:53",
      "BANKNIFTY option premium ticks: 170 minutes covered (need 340), last at 12:04",
    ]);
    expect(verdict.unrecoverable).toEqual(["BANKNIFTY option chain", "BANKNIFTY option premium ticks"]);
  });

  it("flags a chain with no snapshots at all", () => {
    const input = healthy();
    input.chains = [{ underlying: "NIFTY50", snapshots: 0, lastMinute: null }];
    expect(assessSessionCoverage(input).issues[0]).toContain("last at none");
  });

  it("flags thin depth capture", () => {
    const input = healthy();
    input.depthFrames = 5_000;
    expect(assessSessionCoverage(input).issues).toEqual(["market depth: 5000 frames (need 30000)"]);
  });

  it("ignores a timeframe it has no expectation for", () => {
    const input = healthy();
    input.bars = [{ symbol: "NIFTY50", timeframe: "3m", bars: 1 }];
    expect(assessSessionCoverage(input).ok).toBe(true);
  });
});

describe("formatSessionCoverageLine", () => {
  it("logs an error-level line with the issues when there are gaps", () => {
    const input = healthy();
    input.depthFrames = 1;
    const line = JSON.parse(formatSessionCoverageLine("2026-10-19", assessSessionCoverage(input)));
    expect(line.level).toBe("error");
    expect(line.date).toBe("2026-10-19");
    expect(line.unrecoverable).toEqual(["market depth"]);
  });

  it("logs info when complete", () => {
    expect(JSON.parse(formatSessionCoverageLine("2026-10-19", assessSessionCoverage(healthy()))).level).toBe("info");
  });
});
