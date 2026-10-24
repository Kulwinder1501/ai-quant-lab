import { describe, expect, it } from "vitest";
import type { StoredDepthFrame } from "./depth-ladder.js";
import {
  buildReadiness,
  formatReadiness,
  median,
  type DepthSessionInput,
  type ReadinessInput,
} from "./session-readiness.js";

/** Synthetic books, hand-built for the arithmetic below (not recorded from the feed). 10:00 IST on Monday 2026-10-26. */
const MON_1000_IST = new Date("2026-10-26T04:30:00.000Z");

/** 50 levels a side, 65 units each: the stored levels hold 50 x 65 = 3,250 on each side. */
function fullBook(overrides: Partial<StoredDepthFrame> = {}): StoredDepthFrame {
  const levels = Array.from({ length: 50 }, (_, index) => index);
  return {
    providerSymbol: "NSE:BANKNIFTY26NOVFUT",
    sequenceNo: 1,
    exchangeFeedTime: 1_792_000_000,
    receivedAt: MON_1000_IST,
    isSnapshot: false,
    levelsStored: 50,
    levelsAvailable: 50,
    bidPrice: levels.map((index) => 54_200 - index),
    bidQty: levels.map(() => 65),
    bidOrders: levels.map(() => 1),
    askPrice: levels.map((index) => 54_201 + index),
    askQty: levels.map(() => 65),
    askOrders: levels.map(() => 1),
    totalBuyQty: 3_250,
    totalSellQty: 3_250,
    gapBefore: 0,
    isDuplicate: false,
    captureSessionId: "s",
    ...overrides,
  };
}

const depthInput = (overrides: Partial<DepthSessionInput> = {}): DepthSessionInput => ({
  providerSymbol: "NSE:BANKNIFTY26NOVFUT",
  frames: 100,
  framesUntruncated: 100,
  framesCarryingFullDepth: 100,
  framesWithFullDepth: 100,
  maxLevelsStored: 50,
  maxLevelsAvailable: 50,
  sample: [fullBook(), fullBook(), fullBook()],
  ...overrides,
});

function input(overrides: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    date: "2026-10-26",
    depth: [depthInput()],
    vendor: [{ underlying: "BANKNIFTY", snapshots: 4, snapshotsWithVendor: 4, rows: 248, rowsWithVendor: 240 }],
    chainRuns: { completedRuns: 4, notes: [null, null, null, null] },
    lots: [{ symbol: "NIFTY50", lotSize: 65, trades: 3, offLot: 0 }],
    ...overrides,
  };
}

const item = (id: string, data: ReadinessInput) => buildReadiness(data).find((entry) => entry.id === id)!;

describe("median", () => {
  it("takes the middle value, and the mean of the two middle ones for an even count", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("depth item", () => {
  it("reads OK when at least 95% of frames are untruncated and some reached 50, and says what the totals show", () => {
    const depth = item("depth", input());
    expect(depth.state).toBe("OK");
    expect(depth.lines[0]).toContain("100 of 100 frames stored every level they carried, up to 50 (100.0%); 100 carried the full 50 and 100 stored it.");
    // 3,250 stored against a total of 3,250 on both sides: 100%, so the totals appear to count only those levels.
    expect(depth.lines.join("\n")).toContain("a median 100.0% of the bid total and 100.0% of the ask total over 3 full frames");
    expect(depth.lines.join("\n")).toContain("the feed's totals appear to count only those levels");
  });

  it("reads CHECK below 95% untruncated (90 of 100 is 90.0%): frames that carried 50 and stored 10 are truncated", () => {
    const depth = item("depth", input({ depth: [depthInput({ framesUntruncated: 90, framesWithFullDepth: 90 })] }));
    expect(depth.state).toBe("CHECK");
    expect(depth.lines[0]).toContain("90 of 100 frames stored every level they carried, up to 50 (90.0%)");
  });

  it("does not read OK from a session whose frames carried fewer than 50 levels: nothing untruncated shows the cap was raised", () => {
    // Every frame carried 7 levels and stored 7, so none is truncated, but none stored 50 either.
    const depth = item("depth", input({ depth: [depthInput({ framesUntruncated: 100, framesCarryingFullDepth: 0, framesWithFullDepth: 0, maxLevelsStored: 7, maxLevelsAvailable: 7 })] }));
    expect(depth.state).toBe("CHECK");
    expect(depth.lines[0]).toContain("0 carried the full 50 and 0 stored it. Most levels stored 7, most carried 7.");
    expect(depth.lines[1]).toContain("shows nothing about the cap");
  });

  it("says the total counts more than 50 levels when the stored levels are half of it (3,250 of 6,500 is 50.0%)", () => {
    const frames = [fullBook({ totalBuyQty: 6_500, totalSellQty: 6_500 }), fullBook({ totalBuyQty: 6_500, totalSellQty: 6_500 })];
    const text = item("depth", input({ depth: [depthInput({ sample: frames })] })).lines.join("\n");
    expect(text).toContain("a median 50.0% of the bid total and 50.0% of the ask total");
    expect(text).toContain("so it counts more than the 50 levels");
  });

  it("concludes nothing between the two cut-offs (3,250 of 3,350 is 97.0%)", () => {
    const frames = [fullBook({ totalBuyQty: 3_350, totalSellQty: 3_350 })];
    const text = item("depth", input({ depth: [depthInput({ sample: frames })] })).lines.join("\n");
    expect(text).toContain("a median 97.0% of the bid total");
    expect(text).toContain("neither clearly, so nothing is concluded");
  });

  it("counts a crossed book as incoherent without changing the item state, and leaves it out of the totals", () => {
    const crossed = fullBook({ bidPrice: Array.from({ length: 50 }, (_, index) => 54_300 - index) });
    const depth = item("depth", input({ depth: [depthInput({ sample: [fullBook(), fullBook(), fullBook(), crossed] })] }));
    expect(depth.state).toBe("OK");
    expect(depth.lines.join("\n")).toContain("Of 4 sampled frames, 1 failed the book's own invariants (25.0%). No threshold is set");
    expect(depth.lines.join("\n")).toContain("over 3 full frames");
  });

  it("does not judge the totals from frames that hold fewer than 50 levels on a side", () => {
    const short = fullBook({ levelsStored: 10, bidPrice: [54_200], bidQty: [65], bidOrders: [1], askPrice: [54_201], askQty: [65], askOrders: [1] });
    const text = item("depth", input({ depth: [depthInput({ sample: [short], framesUntruncated: 100, framesCarryingFullDepth: 0, framesWithFullDepth: 0 })] }));
    expect(text.state).toBe("CHECK");
    expect(text.lines.join("\n")).toContain("whether the totals stop at 50 is not assessed");
  });

  it("is NO_DATA with no frames, and with no symbol at all", () => {
    expect(item("depth", input({ depth: [depthInput({ frames: 0, framesUntruncated: 0, framesCarryingFullDepth: 0, framesWithFullDepth: 0, sample: [] })] })).state).toBe("NO_DATA");
    expect(item("depth", input({ depth: [] })).state).toBe("NO_DATA");
  });
});

describe("vendor Greeks item", () => {
  it("reads OK when every in-session snapshot carries some, and reports the row share (240 of 248 is 96.8%)", () => {
    const vendor = item("vendor-greeks", input());
    expect(vendor.state).toBe("OK");
    expect(vendor.lines[0]).toBe("BANKNIFTY: 4 of 4 snapshots carry Fyers Greeks; 240 of 248 contract rows (96.8%).");
  });

  it("reads CHECK when some snapshots carry none", () => {
    const vendor = item("vendor-greeks", input({ vendor: [{ underlying: "BANKNIFTY", snapshots: 4, snapshotsWithVendor: 3, rows: 248, rowsWithVendor: 180 }] }));
    expect(vendor.state).toBe("CHECK");
  });

  it("says a date before the deploy is the old code, and is CHECK even if values are there", () => {
    const vendor = item("vendor-greeks", input({ date: "2026-10-23", vendor: [{ underlying: "BANKNIFTY", snapshots: 15, snapshotsWithVendor: 0, rows: 900, rowsWithVendor: 0 }] }));
    expect(vendor.state).toBe("CHECK");
    expect(vendor.lines.join("\n")).toContain("before 2026-10-24: the collector did not store Fyers Greeks yet");
  });

  it("is NO_DATA when no snapshot is stored", () => {
    expect(item("vendor-greeks", input({ vendor: [{ underlying: "BANKNIFTY", snapshots: 0, snapshotsWithVendor: 0, rows: 0, rowsWithVendor: 0 }] })).state).toBe("NO_DATA");
    expect(item("vendor-greeks", input({ vendor: [] })).state).toBe("NO_DATA");
  });

  it("is OK for the underlying that has data and says so for one that has none", () => {
    const vendor = item("vendor-greeks", input({ vendor: [
      { underlying: "BANKNIFTY", snapshots: 4, snapshotsWithVendor: 4, rows: 248, rowsWithVendor: 240 },
      { underlying: "NIFTY50", snapshots: 0, snapshotsWithVendor: 0, rows: 0, rowsWithVendor: 0 },
    ] }));
    expect(vendor.state).toBe("OK");
    expect(vendor.lines).toContain("NIFTY50: no in-session snapshot stored.");
  });
});

describe("partial runs item", () => {
  const note = (...names: string[]) => `PARTIAL ${JSON.stringify({ failures: names.map((underlyingSymbol) => ({ underlyingSymbol, reason: "HTTP 500" })) })}`;

  it("reads OK with no partial run, and says zero is not proof the note works", () => {
    const partial = item("partial-runs", input());
    expect(partial.state).toBe("OK");
    expect(partial.lines[0]).toBe("0 of 4 completed option-chain runs recorded a partial failure.");
    expect(partial.lines.join("\n")).toContain("only proven to be written once one run has recorded a failure");
  });

  it("counts a run once per underlying even when both of its expiries failed, and ignores notes that are not partial notes", () => {
    const notes = [note("NIFTY50", "NIFTY50 (tradable expiry 2026-10-27)"), note("BANKNIFTY"), "some other text", null];
    const partial = item("partial-runs", input({ chainRuns: { completedRuns: 4, notes } }));
    expect(partial.state).toBe("CHECK");
    expect(partial.lines).toContain("2 of 4 completed option-chain runs recorded a partial failure.");
    expect(partial.lines).toContain("  BANKNIFTY: 1 run could not collect it.");
    expect(partial.lines).toContain("  NIFTY50: 1 run could not collect it.");
  });

  it("says that zero means nothing before the deploy, and is NO_DATA with no completed run", () => {
    expect(item("partial-runs", input({ date: "2026-10-23" })).lines.join("\n")).toContain("a count of zero says nothing");
    expect(item("partial-runs", input({ chainRuns: { completedRuns: 0, notes: [] } })).state).toBe("NO_DATA");
  });
});

describe("lot sizing item", () => {
  it("reads OK when no trade opened that date is off the lot", () => {
    const lots = item("lot-sizing", input());
    expect(lots.state).toBe("OK");
    expect(lots.lines[0]).toBe("NIFTY50 (lot 65): 3 paper trades opened, 0 not a whole multiple of the lot.");
  });

  it("reads CHECK on any off-lot trade, and says that is history for NIFTY50 before the deploy", () => {
    const after = item("lot-sizing", input({ lots: [{ symbol: "NIFTY50", lotSize: 65, trades: 3, offLot: 1 }] }));
    expect(after.state).toBe("CHECK");
    const before = item("lot-sizing", input({ date: "2026-10-23", lots: [{ symbol: "NIFTY50", lotSize: 65, trades: 1, offLot: 1 }] }));
    expect(before.lines.join("\n")).toContain("sized at 75 units a lot until the correction to 65");
  });

  it("is NO_DATA when no paper trade opened, and does not list instruments with none", () => {
    const lots = item("lot-sizing", input({ lots: [{ symbol: "NIFTY50", lotSize: 65, trades: 0, offLot: 0 }, { symbol: "BANKNIFTY", lotSize: 30, trades: 2, offLot: 0 }] }));
    expect(lots.lines[0]).toBe("BANKNIFTY (lot 30): 2 paper trades opened, 0 not a whole multiple of the lot.");
    expect(lots.lines.join("\n")).not.toContain("NIFTY50 (lot 65)");
    expect(item("lot-sizing", input({ lots: [] })).state).toBe("NO_DATA");
  });
});

describe("formatReadiness", () => {
  it("prints a header, then each item with its state and indented lines", () => {
    const lines = formatReadiness("2026-10-26", buildReadiness(input()));
    expect(lines[0]).toBe("Session readiness for 2026-10-26 (IST). Reads what is stored; nothing here is a trading signal.");
    expect(lines).toContain("[OK] Depth collector at 50 levels");
    expect(lines).toContain("[OK] Paper orders in whole lots");
    expect(lines.filter((line) => line.startsWith("["))).toHaveLength(4);
  });
});
