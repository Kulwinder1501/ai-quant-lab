import { describe, expect, it } from "vitest";
import {
  ReconcileExpiredProvisionalCandles,
  type ExpiredProvisionalCandleRepository,
} from "./reconcile-expired-provisional-candles.js";

describe("ReconcileExpiredProvisionalCandles", () => {
  it("deletes only rows older than the one-hour grace boundary", async () => {
    const received: Date[] = [];
    const repository: ExpiredProvisionalCandleRepository = {
      deleteExpiredProvisionalCandles: async (closedBefore) => {
        received.push(closedBefore);
        return 2;
      },
    };

    const result = await new ReconcileExpiredProvisionalCandles(repository).execute({
      now: new Date("2026-08-12T10:35:00.000Z"),
    });

    expect(received[0]?.toISOString()).toBe("2026-08-12T09:35:00.000Z");
    expect(result).toEqual({
      closedBefore: new Date("2026-08-12T09:35:00.000Z"),
      candlesDeleted: 2,
    });
  });

  it("rejects an invalid grace period before touching persistence", async () => {
    let called = false;
    const repository: ExpiredProvisionalCandleRepository = {
      deleteExpiredProvisionalCandles: async () => {
        called = true;
        return 0;
      },
    };

    await expect(new ReconcileExpiredProvisionalCandles(repository).execute({
      graceMilliseconds: -1,
    })).rejects.toThrow("graceMilliseconds");
    expect(called).toBe(false);
  });
});
