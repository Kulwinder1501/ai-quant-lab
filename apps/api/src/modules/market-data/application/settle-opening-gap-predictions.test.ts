import { describe, expect, it, vi } from "vitest";
import {
  SettleOpeningGapPredictions,
  type OpeningGapSettlementRepository,
  type SettleableOpeningGapPrediction,
} from "./settle-opening-gap-predictions.js";

const NOW = new Date("2026-10-12T10:00:00.000Z");

function pending(overrides: Partial<SettleableOpeningGapPrediction> = {}): SettleableOpeningGapPrediction {
  return {
    id: "pred-1",
    instrumentSymbol: "NIFTY50",
    sessionDate: "2026-10-12",
    expectation: "GAP_UP",
    ...overrides,
  };
}

function buildRepo(overrides: Partial<OpeningGapSettlementRepository> = {}): OpeningGapSettlementRepository {
  return {
    listPendingSettlement: vi.fn().mockResolvedValue([]),
    findPreviousClose: vi.fn().mockResolvedValue(null),
    findSessionOpen: vi.fn().mockResolvedValue(null),
    recordSettlement: vi.fn().mockResolvedValue(undefined),
    recordUnsettleable: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("SettleOpeningGapPredictions", () => {
  it("settles a prediction once both the previous close and session open are known", async () => {
    const repo = buildRepo({
      listPendingSettlement: vi.fn().mockResolvedValue([pending()]),
      findPreviousClose: vi.fn().mockResolvedValue(25000),
      findSessionOpen: vi.fn().mockResolvedValue(25075), // +0.30%, matches GAP_UP
    });

    const result = await new SettleOpeningGapPredictions(repo, () => NOW).execute();

    expect(result).toEqual({ examined: 1, settled: 1, notYetMatured: 0, unsettleable: 0 });
    expect(repo.recordSettlement).toHaveBeenCalledWith(
      "pred-1",
      expect.objectContaining({ previousClose: 25000, actualOpen: 25075, actualExpectation: "GAP_UP", wasCorrect: true }),
    );
  });

  it("passes the 09:15 IST instant for the prediction's own session date to findSessionOpen", async () => {
    const findSessionOpen = vi.fn().mockResolvedValue(null);
    const repo = buildRepo({
      listPendingSettlement: vi.fn().mockResolvedValue([pending()]),
      findPreviousClose: vi.fn().mockResolvedValue(25000),
      findSessionOpen,
    });

    await new SettleOpeningGapPredictions(repo, () => NOW).execute();

    expect(findSessionOpen).toHaveBeenCalledWith("NIFTY50", new Date("2026-10-12T03:45:00.000Z"));
  });

  it("leaves a recent prediction as not-yet-matured when the open candle is missing", async () => {
    const repo = buildRepo({
      listPendingSettlement: vi.fn().mockResolvedValue([pending({ sessionDate: "2026-10-12" })]),
      findPreviousClose: vi.fn().mockResolvedValue(25000),
      findSessionOpen: vi.fn().mockResolvedValue(null),
    });

    const result = await new SettleOpeningGapPredictions(repo, () => NOW).execute();

    expect(result).toEqual({ examined: 1, settled: 0, notYetMatured: 1, unsettleable: 0 });
    expect(repo.recordUnsettleable).not.toHaveBeenCalled();
  });

  it("marks a stale prediction unsettleable instead of retrying forever", async () => {
    const repo = buildRepo({
      listPendingSettlement: vi.fn().mockResolvedValue([pending({ sessionDate: "2026-09-01" })]),
      findPreviousClose: vi.fn().mockResolvedValue(25000),
      findSessionOpen: vi.fn().mockResolvedValue(null),
    });

    const result = await new SettleOpeningGapPredictions(repo, () => NOW).execute();

    expect(result).toEqual({ examined: 1, settled: 0, notYetMatured: 0, unsettleable: 1 });
    expect(repo.recordUnsettleable).toHaveBeenCalledWith("pred-1", "NO_SESSION_OPEN_CANDLE");
  });

  it("rejects a non-positive limit", async () => {
    const repo = buildRepo();
    await expect(new SettleOpeningGapPredictions(repo, () => NOW).execute({ limit: 0 })).rejects.toThrow(/positive/);
  });
});
