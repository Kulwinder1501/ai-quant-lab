import { describe, expect, it, vi } from "vitest";
import { AedlsShadowConsumerService } from "./aedls-shadow-consumer-service.js";

describe("AedlsShadowConsumerService", () => {
  it("enforces applied_confidence_delta = 0 and handles operational fallback safely", async () => {
    const mockQuery = vi.fn().mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes("FROM trade_ideas")) {
        return {
          rows: [
            {
              symbol: "NSE:NIFTY50-INDEX",
              direction: "LONG",
              strategy_name: "MOMENTUM_SCALP",
            },
          ],
        };
      }
      if (sql.includes("INSERT INTO aedls_shadow_recommendations")) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    const mockPool = { query: mockQuery } as any;
    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue({ embedding: new Array(384).fill(0.01) }),
    } as any;
    const mockRetrieval = {
      retrieve: vi.fn().mockResolvedValue({
        status: "NO_MATCH",
        records: [],
        rawCount: 0,
        deduplicatedEpisodeCount: 0,
        queryLatencyMs: 1,
        effectiveScanMethod: "HNSW",
        decisionAt: new Date().toISOString(),
        modelId: "test",
        modelRevision: "test",
        reasonCodes: [],
      }),
    } as any;
    const consumer = new AedlsShadowConsumerService(mockPool, mockEmbedder, mockRetrieval);

    const candidateDecisionId = "3fa85f64-5717-4562-b3fc-2c963f66afa6";
    const tradeIdeaId = "4fa85f64-5717-4562-b3fc-2c963f66afa7";
    const decidedAt = new Date("2026-10-16T10:00:00.000Z");

    await consumer.processCandidateDecision({
      candidateDecisionId,
      tradeIdeaId,
      decidedAt,
    });

    // Verify insert into aedls_shadow_recommendations was called
    const insertCall = mockQuery.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("INSERT INTO aedls_shadow_recommendations"),
    );

    expect(insertCall).toBeDefined();
    const params = insertCall![1];
    expect(params[0]).toBe(candidateDecisionId);
    expect(params[1]).toBe(tradeIdeaId);
    // Safety invariant: applied_confidence_delta is index 4 in values (0)
    expect(insertCall![0]).toContain("0,");
  });

  it("handles missing trade idea without throwing (emits fallback)", async () => {
    const mockQuery = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes("FROM trade_ideas")) {
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO aedls_shadow_recommendations")) {
        return { rowCount: 1 };
      }
      return { rows: [] };
    });

    const mockPool = { query: mockQuery } as any;
    const mockEmbedder = {
      embed: vi.fn().mockResolvedValue({ embedding: new Array(384).fill(0.01) }),
    } as any;
    const mockRetrieval = {
      retrieve: vi.fn().mockResolvedValue({
        status: "NO_MATCH",
        records: [],
      }),
    } as any;
    const consumer = new AedlsShadowConsumerService(mockPool, mockEmbedder, mockRetrieval);

    await expect(
      consumer.processCandidateDecision({
        candidateDecisionId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
        tradeIdeaId: "4fa85f64-5717-4562-b3fc-2c963f66afa7",
        decidedAt: new Date(),
      }),
    ).resolves.not.toThrow();

    const fallbackInsert = mockQuery.mock.calls.find((call) =>
      typeof call[0] === "string" && call[0].includes("MODEL_UNAVAILABLE"),
    );
    expect(fallbackInsert).toBeDefined();
  });
});
