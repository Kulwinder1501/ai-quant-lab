import { describe, expect, it, vi } from "vitest";
import { resolveTapeLiveness, type TapeBarReader } from "./resolve-tape-liveness.js";
import type { TapeBar } from "../domain/tape-liveness.js";

const MINUTE = 60_000;
const referenceCloseTime = new Date("2026-08-31T09:46:00.000Z");

function bar(offsetMinutes: number, values: Partial<TapeBar> = {}): TapeBar {
  return {
    openTime: new Date(referenceCloseTime.getTime() + (offsetMinutes - 1) * MINUTE),
    open: 24_308,
    high: 24_315,
    low: 24_306,
    close: 24_312,
    ...values,
  };
}

/** Serves bars by the closeTime asked for; anything not listed is a miss. */
function reader(byCloseTimeIso: Record<string, TapeBar>): TapeBarReader & { calls: Date[] } {
  const calls: Date[] = [];
  return {
    calls,
    async findCompletedAt(input) {
      calls.push(input.closeTime);
      const found = byCloseTimeIso[input.closeTime.toISOString()];
      return found ? { candle: found } : null;
    },
  };
}

describe("resolveTapeLiveness", () => {
  it("asks for exactly the one predecessor the default threshold needs", async () => {
    const previousCloseIso = new Date(referenceCloseTime.getTime() - MINUTE).toISOString();
    const store = reader({ [previousCloseIso]: bar(0) });

    await resolveTapeLiveness({
      reader: store,
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
    });

    // Threshold 2 = reference bar plus one predecessor. Fetching more would be wasted queries per
    // grid point; fetching fewer would make the check unable to fire at all.
    expect(store.calls.map((item) => item.toISOString())).toEqual([previousCloseIso]);
  });

  it("reports FROZEN when the predecessor is value-identical", async () => {
    const previousCloseIso = new Date(referenceCloseTime.getTime() - MINUTE).toISOString();
    const store = reader({ [previousCloseIso]: bar(0) });

    const result = await resolveTapeLiveness({
      reader: store,
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
    });

    expect(result).toEqual({ liveness: "FROZEN", identicalBars: 2 });
  });

  it("reports LIVE when the predecessor differs", async () => {
    const previousCloseIso = new Date(referenceCloseTime.getTime() - MINUTE).toISOString();
    const store = reader({ [previousCloseIso]: bar(0, { close: 24_311 }) });

    const result = await resolveTapeLiveness({
      reader: store,
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
    });

    expect(result.liveness).toBe("LIVE");
  });

  it("reports LIVE when there is no predecessor at all", async () => {
    // 09:16, or a hole in the series. Absence of a comparable bar is absence of evidence that the
    // tape repeated -- not evidence that it moved, and not a reason to discard the grid point.
    const result = await resolveTapeLiveness({
      reader: reader({}),
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
    });

    expect(result).toEqual({ liveness: "LIVE", identicalBars: 1 });
  });

  it("passes the bars oldest-first, so a raised threshold still counts a real run", async () => {
    /*
     * Guards the ordering seam. The walk collects predecessors newest-first and has to reverse them
     * before handing them over, because `assessTapeLiveness` breaks its run at the first
     * non-contiguous pair. Reversed wrongly, a genuine three-bar freeze would read as LIVE.
     */
    const store = reader({
      [new Date(referenceCloseTime.getTime() - MINUTE).toISOString()]: bar(0),
      [new Date(referenceCloseTime.getTime() - 2 * MINUTE).toISOString()]: bar(-1),
    });

    const result = await resolveTapeLiveness({
      reader: store,
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
      threshold: 3,
    });

    expect(result).toEqual({ liveness: "FROZEN", identicalBars: 3 });
  });

  it("stops walking at the first gap rather than skipping over it", async () => {
    // Only the bar two minutes back exists. Continuing past the hole would compare across it and
    // could manufacture a run from non-adjacent bars.
    const store = reader({
      [new Date(referenceCloseTime.getTime() - 2 * MINUTE).toISOString()]: bar(-1),
    });

    const result = await resolveTapeLiveness({
      reader: store,
      instrumentId: "instrument-1",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
      threshold: 3,
    });

    expect(result.liveness).toBe("LIVE");
    expect(store.calls).toHaveLength(1);
  });

  it("queries the instrument and timeframe it was given", async () => {
    const findCompletedAt = vi.fn().mockResolvedValue(null);

    await resolveTapeLiveness({
      reader: { findCompletedAt },
      instrumentId: "instrument-9",
      timeframe: "1m",
      referenceBar: bar(1),
      referenceCloseTime,
      intervalMs: MINUTE,
    });

    expect(findCompletedAt).toHaveBeenCalledWith(expect.objectContaining({
      instrumentId: "instrument-9",
      timeframe: "1m",
    }));
  });
});
