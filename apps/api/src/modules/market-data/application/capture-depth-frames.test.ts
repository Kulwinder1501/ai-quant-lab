import { describe, expect, it } from "vitest";
import { DepthFrameBuffer } from "./capture-depth-frames.js";
import type { DepthFrame } from "../domain/depth-frame.js";

function frame(sequenceNo: number | null, overrides: Partial<DepthFrame> = {}): DepthFrame {
  return {
    providerSymbol: "NSE:BANKNIFTY26OCTFUT",
    sequenceNo,
    exchangeFeedTime: null,
    vendorSendTime: null,
    receivedAt: new Date("2026-09-11T04:00:00Z"),
    isSnapshot: false,
    levelsStored: 1,
    levelsAvailable: 1,
    bidPrice: [100],
    bidQty: [10],
    bidOrders: [1],
    askPrice: [101],
    askQty: [10],
    askOrders: [1],
    totalBuyQty: 100,
    totalSellQty: 120,
    payloadDigest: `digest-${sequenceNo}`,
    ...overrides,
  };
}

function capture(sequences: Array<number | { seq: number; snapshot: true }>): ReturnType<DepthFrameBuffer["drain"]> {
  const buffer = new DepthFrameBuffer("test-provider");
  for (const s of sequences) {
    if (typeof s === "number") buffer.accept(frame(s));
    else buffer.accept(frame(s.seq, { isSnapshot: true }));
  }
  return buffer.drain();
}

describe("DepthFrameBuffer sequence continuity", () => {
  it("marks a clean ascending run contiguous with no regressions", () => {
    const rows = capture([1, 2, 3, 4]);
    expect(rows.map((r) => r.gapBefore)).toEqual([null, 0, 0, 0]);
    expect(rows.every((r) => !r.isRegression && !r.isDuplicate)).toBe(true);
  });

  it("flags ONLY the reset frame as a regression after a sequence reset without a snapshot", () => {
    // 1000..1004, then the feed restarts at 1 with no snapshot flag and runs on 1..30.
    const tail = Array.from({ length: 30 }, (_, i) => i + 1);
    const rows = capture([1000, 1001, 1002, 1003, 1004, ...tail]);

    const regressions = rows.filter((r) => r.isRegression);
    // Old behaviour: the marker never moved back, so all 30 post-reset frames were regressions.
    expect(regressions).toHaveLength(1);
    expect(regressions[0]!.sequenceNo).toBe(1);
    expect(regressions[0]!.gapBefore).toBeNull(); // the chain break

    // Frames after the reset are clean and contiguous (gapBefore 0), so OFI chains again.
    const after = rows.slice(6);
    expect(after).toHaveLength(29);
    expect(after.every((r) => !r.isRegression && !r.isDuplicate && r.gapBefore === 0)).toBe(true);
  });

  it("does not flag a regression for a snapshot restart, and re-bases on it", () => {
    const rows = capture([100, 101, { seq: 5, snapshot: true }, 6, 7]);
    expect(rows.map((r) => r.isRegression)).toEqual([false, false, false, false, false]);
    expect(rows.map((r) => r.gapBefore)).toEqual([null, 0, null, 0, 0]);
  });

  it("still counts a real forward gap after a reset", () => {
    const rows = capture([500, 501, 1, 2, 5]);
    expect(rows.map((r) => r.isRegression)).toEqual([false, false, true, false, false]);
    expect(rows[4]!.gapBefore).toBe(2); // 3 and 4 never arrived
  });

  it("keeps flagging replayed sequence numbers as duplicates", () => {
    const rows = capture([10, 11, 11, 12]);
    expect(rows.map((r) => r.isDuplicate)).toEqual([false, false, true, false]);
    expect(rows[3]!.gapBefore).toBe(0);
  });

  it("a single stale frame is one regression; the follow-up shows a visible (conservative) gap", () => {
    // Documented trade-off of re-basing: 100, 101, then a stale 95 arrives, then 102 resumes.
    const rows = capture([100, 101, 95, 102]);
    expect(rows.map((r) => r.isRegression)).toEqual([false, false, true, false]);
    expect(rows[3]!.gapBefore).toBe(6); // a reported chain break, never a silent regression storm
  });

  it("tracks continuity per symbol", () => {
    const buffer = new DepthFrameBuffer("test-provider");
    buffer.accept(frame(100, { providerSymbol: "A" }));
    buffer.accept(frame(5, { providerSymbol: "B" }));
    buffer.accept(frame(101, { providerSymbol: "A" }));
    buffer.accept(frame(6, { providerSymbol: "B" }));
    const rows = buffer.drain();
    expect(rows.some((r) => r.isRegression)).toBe(false);
    expect(rows.map((r) => r.gapBefore)).toEqual([null, null, 0, 0]);
  });

  it("leaves the marker alone for frames without a usable sequence number", () => {
    const buffer = new DepthFrameBuffer("test-provider");
    buffer.accept(frame(10));
    buffer.accept(frame(null));
    buffer.accept(frame(11));
    const rows = buffer.drain();
    expect(rows.map((r) => r.gapBefore)).toEqual([null, null, 0]);
  });
});
