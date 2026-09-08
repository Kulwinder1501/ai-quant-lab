import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { buildStrategyDefinition } from "../../../modules/research/scalp-harness/domain/contracts.js";
import { sha256CanonicalJson } from "../../../modules/platform/identity/identity.js";
import { IdempotencyPayloadConflictError, PostgresScalpResearchRepository } from "./postgres-scalp-research-repository.js";

const definition = buildStrategyDefinition({
  strategyKey: "test-research", researchVersion: 1, featureSchemaVersion: "features-v1",
  implementationArtifactChecksum: "a".repeat(64), configuration: { threshold: 1 },
});

describe("PostgresScalpResearchRepository idempotency", () => {
  it("returns the existing row for an identical retry", async () => {
    const payloadHash = sha256CanonicalJson(definition);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "existing", payload_hash: payloadHash }] });
    const repository = new PostgresScalpResearchRepository({ query } as unknown as DatabasePool);
    await expect(repository.saveStrategyDefinition(definition)).resolves.toBe("existing");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("detects a changed payload under the same logical key and performs no update", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "existing", payload_hash: "f".repeat(64) }] });
    const repository = new PostgresScalpResearchRepository({ query } as unknown as DatabasePool);
    await expect(repository.saveStrategyDefinition(definition)).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
    expect(String(query.mock.calls[0]?.[0])).toContain("ON CONFLICT (strategy_definition_hash) DO NOTHING");
    expect(String(query.mock.calls[0]?.[0])).not.toContain("DO UPDATE");
  });

  it("keeps the original capture when a proposal is re-derived with a different payload", async () => {
    /*
     * A capture row's payload embeds volatile feature covariates. The pattern-intelligence layer is
     * backfilled after capture, so catch-up re-deriving a decision point later produces a different
     * payload for the same decision. On 2026-09-08 that took live capture down: every harness tick
     * aborted on a 09:16 1m proposal, and the failure was image-independent.
     *
     * The first capture must stay authoritative -- that is the property the guard protects -- but a
     * later, differently-derived view of an already-captured point must not abort the run.
     */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ id: "captured-first", payload_hash: "f".repeat(64) }] });
      const repository = new PostgresScalpResearchRepository({ query } as unknown as DatabasePool);

      const proposal = {
        proposalKey: "prop-key-1", payloadHash: "b".repeat(64), strategyDefinitionHash: definition.strategyDefinitionHash,
        strategyKey: "test-research", strategyResearchVersion: 1, instrumentId: "inst-1",
        sourceCandleId: "c-1", referenceCandleId: "c-1", timeframe: "1m", direction: "LONG",
        decisionAt: new Date("2026-09-08T03:46:00.000Z"), dataThrough: new Date("2026-09-08T03:46:00.000Z"),
        referencePrice: 100, setupType: "X", setupFingerprint: "fp", nativeGeometry: {}, rawContext: {},
      } as never;

      const saved = await repository.saveProposal(proposal);
      // The row that was already there wins, and the run continues.
      expect(saved.id).toBe("captured-first");
      // The divergence is recorded, not swallowed.
      expect(warn).toHaveBeenCalledTimes(1);
      const line = JSON.parse(warn.mock.calls[0][0] as string);
      expect(line.message).toContain("keeping the original capture");
      expect(line.existingPayloadHash).toBe("f".repeat(64));
      // No UPDATE: the stored payload is never rewritten.
      expect(String(query.mock.calls[0]?.[0])).not.toContain("DO UPDATE");
    } finally {
      warn.mockRestore();
    }
  });

  it("still throws for a strategy definition, where the key IS the payload hash", async () => {
    // Divergence there cannot be legitimate, so it must stay fatal rather than be waved through.
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "existing", payload_hash: "e".repeat(64) }] });
    const repository = new PostgresScalpResearchRepository({ query } as unknown as DatabasePool);
    await expect(repository.saveStrategyDefinition(definition)).rejects.toBeInstanceOf(IdempotencyPayloadConflictError);
  });
});
