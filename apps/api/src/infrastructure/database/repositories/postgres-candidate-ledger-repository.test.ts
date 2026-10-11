import { describe, expect, it, vi } from "vitest";
import { PostgresCandidateLedgerRepository } from "./postgres-candidate-ledger-repository.js";
import type { OptionEntryRejectionProvenance } from "../../../modules/paper-trading/domain/paper-trade-open-errors.js";

describe("PostgresCandidateLedgerRepository", () => {
  it("persists and reads back rejection_provenance as exact JSON", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query } as any;
    const repository = new PostgresCandidateLedgerRepository(database);

    const accountId = "acc-1";
    const tradeIdeaId = "idea-1";

    const provenance: OptionEntryRejectionProvenance = {
      reasonCode: "NO_OPTION_ENTRY",
      underlyingSymbol: "BANKNIFTY",
      underlyingValue: 54510.25,
      expiry: "2026-10-27",
      optionType: "PE",
      chainObservedAt: "2026-10-08T15:05:00+05:30",
      targetDelta: 0.65,
      minEntryDelta: 0.55,
      candidateCount: 50,
      deltaAvailableCount: 48,
      minAvailableStrike: 53100,
      maxAvailableStrike: 56000,
      maxAbsDeltaAvailable: 0.70,
      liquidityEligibleCount: 17,
      maxAbsDeltaLiquidityEligible: 0.63,
    };

    const decidedAt = new Date("2026-10-08T15:05:00.000Z");

    await repository.recordDecision({
      tradeIdeaId,
      accountId,
      decidedAt,
      decision: "REFUSED",
      reason: "NO_OPTION_ENTRY",
      explanation: "No eligible option contract found.",
      rejectionProvenance: provenance,
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO candidate_decisions"),
      expect.arrayContaining([
        tradeIdeaId,
        accountId,
        decidedAt,
        "REFUSED",
        "NO_OPTION_ENTRY",
        "No eligible option contract found.",
        null,
        null,
        JSON.stringify(provenance),
      ])
    );
  });

  it("persists NULL when no provenance is provided", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const database = { query } as any;
    const repository = new PostgresCandidateLedgerRepository(database);

    const accountId = "acc-1";
    const tradeIdeaId = "idea-1";

    await repository.recordDecision({
      tradeIdeaId,
      accountId,
      decidedAt: new Date(),
      decision: "REFUSED",
      reason: "OTHER_REASON",
      explanation: "Something else failed.",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO candidate_decisions"),
      expect.arrayContaining([
        tradeIdeaId,
        accountId,
        expect.any(Date),
        "REFUSED",
        "OTHER_REASON",
        "Something else failed.",
        null,
        null,
        null,
      ])
    );
  });
});
