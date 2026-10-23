import { describe, expect, it } from "vitest";
import {
  buildDepthHistory,
  DEPTH_GAP_SECONDS,
  sessionWindowUtc,
  UNATTRIBUTED_CAPTURE_SESSION,
} from "./depth-history.js";
import type { StoredDepthFrame } from "./depth-ladder.js";

/** 2026-10-12 is a Monday; IST = UTC + 5:30, so 10:00 IST = 04:30Z. */
const MON_1000_IST = new Date("2026-10-12T04:30:00.000Z");
const at = (seconds: number) => new Date(MON_1000_IST.getTime() + seconds * 1000);

/**
 * Synthetic frames, hand-built for the arithmetic below (not recorded from the feed). Five levels a side, so
 * the level-5 figure exists; `bidQty`/`askQty` are per level and `spread` is the touch-to-touch distance.
 */
function frame(
  receivedAt: Date,
  { spread = 20, bidQty = [30, 30, 30, 30, 30], askQty = [30, 30, 30, 30, 30], ...overrides }:
    Partial<StoredDepthFrame> & { spread?: number; bidQty?: number[]; askQty?: number[] } = {},
): StoredDepthFrame {
  return {
    providerSymbol: "NSE:BANKNIFTY26OCTFUT",
    sequenceNo: 1,
    exchangeFeedTime: 1_792_000_000,
    receivedAt,
    isSnapshot: false,
    levelsStored: 5,
    levelsAvailable: 50,
    bidPrice: [54_200, 54_199.8, 54_199.6, 54_199.4, 54_199.2],
    bidQty,
    bidOrders: [1, 1, 1, 1, 1],
    askPrice: [54_200 + spread, 54_200.2 + spread, 54_200.4 + spread, 54_200.6 + spread, 54_200.8 + spread],
    askQty,
    askOrders: [1, 1, 1, 1, 1],
    totalBuyQty: 42_000,
    totalSellQty: 42_000,
    gapBefore: 0,
    isDuplicate: false,
    captureSessionId: "session-1",
    ...overrides,
  };
}

describe("buildDepthHistory: buckets", () => {
  it("puts a frame in the bucket that starts at or before it, and the next boundary starts the next bucket", () => {
    const history = buildDepthHistory(
      [frame(at(0)), frame(at(59.999)), frame(at(60)), frame(at(61))],
      { bucketSeconds: 60 },
    );
    expect(history.buckets.map((b) => [b.t, b.frames])).toEqual([
      ["2026-10-12T04:30:00.000Z", 2],
      ["2026-10-12T04:31:00.000Z", 2],
    ]);
  });

  it("honours the bucket size", () => {
    const frames = [frame(at(0)), frame(at(100)), frame(at(250)), frame(at(310))];
    expect(buildDepthHistory(frames, { bucketSeconds: 300 }).buckets.map((b) => b.frames)).toEqual([3, 1]);
    expect(buildDepthHistory(frames, { bucketSeconds: 10 }).buckets).toHaveLength(4);
  });

  it("sorts frames it is handed out of order, so a bucket never depends on arrival order", () => {
    const history = buildDepthHistory([frame(at(61)), frame(at(0)), frame(at(30))]);
    expect(history.buckets.map((b) => b.frames)).toEqual([2, 1]);
  });

  it("returns an empty history for no frames, without inventing a bucket", () => {
    const history = buildDepthHistory([]);
    expect(history.buckets).toEqual([]);
    expect(history.gaps).toEqual([]);
    expect(history.counts.framesRead).toBe(0);
  });
});

describe("buildDepthHistory: spread and imbalance", () => {
  it("reports the median spread, the widest spread, and the median mid", () => {
    const history = buildDepthHistory([
      frame(at(0), { spread: 10 }),
      frame(at(1), { spread: 15 }),
      frame(at(2), { spread: 60 }),
    ]);
    const bucket = history.buckets[0]!;
    expect(bucket.spreadMedianPoints).toBe(15);
    expect(bucket.spreadMaxPoints).toBe(60);
    // Touches are 54,200 / 54,210, 54,215 and 54,260: mids 54,205, 54,207.5 and 54,230.
    expect(bucket.midMedian).toBe(54_207.5);
    expect(bucket.levelFrames).toBe(3);
  });

  it("averages the imbalance over frames: the touch (level 1) and the first five levels (level 5)", () => {
    const history = buildDepthHistory([
      // l1 = (60-30)/90 = +1/3 ; l5 = (60+120 - 30*5)/(180+150) = 30/330
      frame(at(0), { bidQty: [60, 30, 30, 30, 30], askQty: [30, 30, 30, 30, 30] }),
      // l1 = (30-90)/120 = -0.5 ; l5 = (150 - (90+120))/(150+210) = -60/360
      frame(at(1), { bidQty: [30, 30, 30, 30, 30], askQty: [90, 30, 30, 30, 30] }),
    ]);
    const bucket = history.buckets[0]!;
    expect(bucket.imbalanceL1).toBeCloseTo(((1 / 3) + -0.5) / 2, 4);
    expect(bucket.imbalanceL5).toBeCloseTo(((30 / 330) + (-60 / 360)) / 2, 4);
  });

  it("gives null, not zero, when the stored book is too shallow for the level-5 figure", () => {
    const shallow = frame(at(0), {
      levelsStored: 3,
      bidPrice: [54_200, 54_199.8, 54_199.6], bidQty: [30, 30, 30], bidOrders: [1, 1, 1],
      askPrice: [54_220, 54_220.2, 54_220.4], askQty: [30, 30, 30], askOrders: [1, 1, 1],
    });
    const bucket = buildDepthHistory([shallow]).buckets[0]!;
    expect(bucket.imbalanceL5).toBeNull();
    expect(bucket.imbalanceL1).toBe(0);
  });

  it("builds the whole-book figure from the feed totals and leaves out a dropout frame", () => {
    const history = buildDepthHistory([
      frame(at(0), { totalBuyQty: 30_000, totalSellQty: 60_000 }), // -1/3
      frame(at(1), { totalBuyQty: 0, totalSellQty: 47_400 }),       // dropout: not -1
      frame(at(2), { totalBuyQty: 60_000, totalSellQty: 30_000 }), // +1/3
    ]);
    const bucket = history.buckets[0]!;
    expect(bucket.wholeBookFrames).toBe(2);
    expect(bucket.imbalanceWholeBook).toBeCloseTo(0, 4);
    expect(history.counts.framesWithoutWholeBook).toBe(1);
    // The dropout frame still has a book: it counts for the level figures.
    expect(bucket.frames).toBe(3);
    expect(bucket.levelFrames).toBe(3);
  });
});

describe("buildDepthHistory: frames that cannot be used for a level figure", () => {
  it("counts a crossed book in the bucket but not in any level figure, and keeps its whole-book total", () => {
    const crossed = frame(at(0), { spread: -10, totalBuyQty: 60_000, totalSellQty: 30_000 });
    const history = buildDepthHistory([crossed, frame(at(70), { spread: 12 })]);
    const [first, second] = history.buckets;
    expect(first).toMatchObject({
      frames: 1, levelFrames: 0, spreadMedianPoints: null, spreadMaxPoints: null,
      midMedian: null, imbalanceL1: null, imbalanceL5: null, wholeBookFrames: 1,
    });
    expect(first!.imbalanceWholeBook).toBeCloseTo(1 / 3, 4);
    expect(second!.spreadMedianPoints).toBe(12);
    expect(history.counts.framesWithoutLevelMetrics).toBe(1);
  });

  it("withholds level figures from the pre-2026-09-07 capture regime but keeps the whole-book figure", () => {
    // Wednesday 2026-09-02 10:00 IST, before levels were keyed by their own number.
    const old = new Date("2026-09-02T04:30:00.000Z");
    const history = buildDepthHistory([frame(old, { totalBuyQty: 30_000, totalSellQty: 60_000 })]);
    expect(history.buckets[0]).toMatchObject({
      frames: 1, levelFrames: 0, spreadMedianPoints: null, imbalanceL1: null, imbalanceL5: null, wholeBookFrames: 1,
    });
    expect(history.buckets[0]!.imbalanceWholeBook).toBeCloseTo(-1 / 3, 4);
  });

  it("counts a frame flagged duplicate without dropping it: the flag was a collector defect on some days", () => {
    const history = buildDepthHistory([frame(at(0), { isDuplicate: true }), frame(at(1), { isDuplicate: true })]);
    expect(history.counts.framesFlaggedDuplicate).toBe(2);
    expect(history.buckets[0]!.frames).toBe(2);
  });
});

describe("buildDepthHistory: session scope and gaps", () => {
  it("leaves out frames outside Mon-Fri 09:00-15:30 IST and says how many", () => {
    const history = buildDepthHistory([
      frame(new Date("2026-10-12T03:00:00.000Z")), // 08:30 IST, before the open
      frame(at(0)),
      frame(new Date("2026-10-12T10:00:00.000Z")), // 15:30 IST, the close is exclusive
      frame(new Date("2026-10-17T04:30:00.000Z")), // Saturday
    ]);
    expect(history.counts).toMatchObject({ framesRead: 4, framesInSession: 1, framesOutsideSession: 3 });
    expect(history.buckets).toHaveLength(1);
  });

  it("reports a hole longer than the gap threshold and none shorter, and cuts nothing between neighbours", () => {
    const history = buildDepthHistory([frame(at(0)), frame(at(1)), frame(at(1 + DEPTH_GAP_SECONDS)), frame(at(200))]);
    expect(history.gaps).toEqual([
      { from: at(1 + DEPTH_GAP_SECONDS).toISOString(), to: at(200).toISOString(), seconds: 200 - 1 - DEPTH_GAP_SECONDS },
    ]);
  });

  it("does not call the time before the first frame, or after the last, a gap", () => {
    expect(buildDepthHistory([frame(at(0))]).gaps).toEqual([]);
  });
});

describe("buildDepthHistory: capture sessions", () => {
  it("lists each capture session with its frames and span", () => {
    const history = buildDepthHistory([
      frame(at(0), { captureSessionId: "a" }), frame(at(100), { captureSessionId: "a" }),
      frame(at(160), { captureSessionId: "b" }),
    ]);
    expect(history.captureSessions).toEqual([
      { captureSessionId: "a", frames: 2, firstAt: at(0).toISOString(), lastAt: at(100).toISOString() },
      { captureSessionId: "b", frames: 1, firstAt: at(160).toISOString(), lastAt: at(160).toISOString() },
    ]);
    expect(history.concurrentWriters).toEqual([]);
  });

  it("flags two sessions writing the same contract at once, since their interleaved frames are two streams", () => {
    const history = buildDepthHistory([
      frame(at(0), { captureSessionId: "a" }), frame(at(100), { captureSessionId: "a" }),
      frame(at(50), { captureSessionId: "b" }), frame(at(150), { captureSessionId: "b" }),
    ]);
    expect(history.concurrentWriters).toEqual([{
      a: "a", b: "b", overlapFrom: at(50).toISOString(), overlapTo: at(100).toISOString(), overlapSeconds: 50,
    }]);
  });

  it("does not flag a restart: a collector that stops and a new one that starts leave a hole, not an overlap", () => {
    const history = buildDepthHistory([
      frame(at(0), { captureSessionId: "a" }), frame(at(100), { captureSessionId: "a" }),
      frame(at(103), { captureSessionId: "b" }), frame(at(200), { captureSessionId: "b" }),
    ]);
    expect(history.concurrentWriters).toEqual([]);
  });

  it("keeps a frame with no capture session as its own, unattributed, span", () => {
    const history = buildDepthHistory([frame(at(0), { captureSessionId: null })]);
    expect(history.captureSessions[0]!.captureSessionId).toBe(UNATTRIBUTED_CAPTURE_SESSION);
    expect(history.captureSessions[0]!.frames).toBe(1);
  });

  it("reports even a one-second overlap, with its length, instead of judging it against a tolerance", () => {
    const history = buildDepthHistory([
      frame(at(0), { captureSessionId: "a" }), frame(at(100), { captureSessionId: "a" }),
      frame(at(99), { captureSessionId: "b" }), frame(at(200), { captureSessionId: "b" }),
    ]);
    expect(history.concurrentWriters.map((w) => w.overlapSeconds)).toEqual([1]);
  });
});

describe("sessionWindowUtc", () => {
  it("is 09:00 up to 15:30 IST for the given calendar day, as UTC, half-open", () => {
    const { from, to } = sessionWindowUtc("2026-10-22");
    expect(from.toISOString()).toBe("2026-10-22T03:30:00.000Z");
    expect(to.toISOString()).toBe("2026-10-22T10:00:00.000Z");
  });
});
