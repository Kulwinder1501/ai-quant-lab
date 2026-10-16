import { describe, expect, it } from "vitest";
import { FyersRequestCounter, reportFyersRequestCounts } from "./fyers-request-counter.js";

describe("FyersRequestCounter", () => {
  it("counts by endpoint, largest first, and starts a fresh window on drain", () => {
    let now = 0;
    const counter = new FyersRequestCounter(() => now, 0);
    counter.record("quotes:api");
    counter.record("history");
    counter.record("quotes:api");
    counter.record("quotes:api");
    now = 300_000;

    const window = counter.drain();
    expect(window.total).toBe(4);
    expect(window.windowSeconds).toBe(300);
    expect(Object.entries(window.counts)).toEqual([["quotes:api", 3], ["history", 1]]);

    now = 360_000;
    const next = counter.drain();
    expect(next.total).toBe(0);
    expect(next.windowSeconds).toBe(60);
  });
});

describe("reportFyersRequestCounts", () => {
  it("writes one JSON line with the script and the counts", () => {
    const counter = new FyersRequestCounter(() => 60_000, 0);
    counter.record("quotes:premium");
    counter.record("quotes:premium");
    const lines: string[] = [];

    reportFyersRequestCounts(counter, (line) => lines.push(line), "collect-option-premium-ticks.js");

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      level: "info",
      message: "Fyers REST request counts",
      script: "collect-option-premium-ticks.js",
      windowSeconds: 60,
      total: 2,
      counts: { "quotes:premium": 2 },
    });
  });

  it("says nothing when no request was sent, so an idle process does not log", () => {
    const lines: string[] = [];
    reportFyersRequestCounts(new FyersRequestCounter(), (line) => lines.push(line), "x.js");
    expect(lines).toEqual([]);
  });
});
