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

  it("maintains cumulative daily total across drain cycles and resets on day rollover", () => {
    // 2026-10-17 10:00:00 IST -> UTC is 04:30:00
    let now = new Date("2026-10-17T04:30:00.000Z").getTime();
    const counter = new FyersRequestCounter(() => now, now);

    counter.record("quotes:api", 5);
    counter.record("history", 10);
    expect(counter.getDailyTotal()).toBe(15);

    // Drain resets window but preserves daily total
    counter.drain();
    expect(counter.getDailyTotal()).toBe(15);

    counter.record("quotes:api", 5);
    expect(counter.getDailyTotal()).toBe(20);

    // Rollover to next day: 2026-10-18 04:30:00 UTC (10:00 IST)
    now = new Date("2026-10-18T04:30:00.000Z").getTime();
    expect(counter.getDailyTotal()).toBe(0);
    counter.record("quotes:api", 3);
    expect(counter.getDailyTotal()).toBe(3);
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
