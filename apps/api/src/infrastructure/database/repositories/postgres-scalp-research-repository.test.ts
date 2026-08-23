import { describe, expect, it, vi } from "vitest";
import type { DatabasePool } from "../database.js";
import { buildStrategyDefinition } from "../../../modules/research/scalp-harness/domain/contracts.js";
import { sha256Canonical } from "../../../modules/research/scalp-harness/domain/identity.js";
import { IdempotencyPayloadConflictError, PostgresScalpResearchRepository } from "./postgres-scalp-research-repository.js";

const definition = buildStrategyDefinition({
  strategyKey: "test-research", researchVersion: 1, featureSchemaVersion: "features-v1",
  implementationArtifactChecksum: "a".repeat(64), configuration: { threshold: 1 },
});

describe("PostgresScalpResearchRepository idempotency", () => {
  it("returns the existing row for an identical retry", async () => {
    const payloadHash = sha256Canonical(definition);
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
});
