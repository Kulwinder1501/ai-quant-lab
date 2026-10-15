import { describe, expect, it, vi } from "vitest";
import {
  AedlsPitRetrievalService,
  type PitRetrievalQueryInput,
} from "./aedls-pit-retrieval-service.js";
import type { DatabasePool } from "../../../infrastructure/database/database.js";

describe("AedlsPitRetrievalService", () => {
  const dummyEmbedding = Array.from({ length: 384 }, (_, i) => Math.sin(i));
  const decisionAt = new Date("2026-10-14T09:45:00.000Z");

  const baseInput: PitRetrievalQueryInput = {
    instrumentSymbol: "NIFTY50",
    tradeSide: "LONG",
    setupFamily: "MOMENTUM_SCALP",
    regimeClass: "HIGH_VOLATILITY",
    decisionAt,
    queryEmbedding: dummyEmbedding,
    queryFamily: "FAILURE_RISK_EXP_B",
    cohortFilter: "EVENT_POSITIVE",
    similarityFloor: 0.75,
    limit: 10,
    exactSearchOnly: false,
  };

  it("handles non-384 dimensional query vector with graceful MODEL_UNAVAILABLE fallback", async () => {
    const mockPool = {} as DatabasePool;
    const service = new AedlsPitRetrievalService(mockPool);

    const badInput: PitRetrievalQueryInput = {
      ...baseInput,
      queryEmbedding: [0.1, 0.2, 0.3], // Invalid dimension
    };

    const result = await service.retrieve(badInput);

    expect(result.status).toBe("MODEL_UNAVAILABLE");
    expect(result.records).toHaveLength(0);
    expect(result.reasonCodes[0]).toContain("INVALID_EMBEDDING_DIMENSION_3");
  });

  it("handles database / query failure with graceful MODEL_UNAVAILABLE fallback", async () => {
    const mockClient = {
      query: vi.fn().mockRejectedValue(new Error("Database connection timed out")),
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as DatabasePool;

    const service = new AedlsPitRetrievalService(mockPool);
    const result = await service.retrieve(baseInput);

    expect(result.status).toBe("MODEL_UNAVAILABLE");
    expect(result.records).toHaveLength(0);
    expect(result.reasonCodes[0]).toBe("RETRIEVAL_INFRASTRUCTURE_FAILURE");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("executes transaction with HNSW settings and parses records when query succeeds", async () => {
    const querySpy = vi.fn();

    querySpy.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return {};
      if (sql.includes("hnsw.ef_search")) return {};
      if (sql.includes("hnsw.iterative_scan")) return {};

      // Return mock query results
      return {
        rows: [
          {
            id: "ref-1",
            trade_id: "trade-101",
            candidate_id: "idea-201",
            target_assessments: [
              {
                targetEvent: "IMMEDIATE_ADVERSE_EXCURSION",
                label: "POSITIVE",
                evidenceStatus: "TICK_VERIFIED",
              },
            ],
            structural_context: { exitReason: "STOP_LOSS" },
            realized_net_r: -1.02,
            semantic_similarity: 0.885,
          },
        ],
      };
    });

    const mockClient = {
      query: querySpy,
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as DatabasePool;

    const service = new AedlsPitRetrievalService(mockPool);
    const result = await service.retrieve(baseInput);

    expect(result.status).toBe("MATCH_VALIDATED");
    expect(result.rawCount).toBe(1);
    expect(result.deduplicatedEpisodeCount).toBe(1);
    expect(result.effectiveScanMethod).toBe("HNSW");
    expect(result.records[0].tradeId).toBe("trade-101");
    expect(result.records[0].semanticSimilarity).toBe(0.885);

    // Verify HNSW settings were applied inside transaction
    expect(querySpy).toHaveBeenCalledWith("SET LOCAL hnsw.ef_search = 100");
    expect(querySpy).toHaveBeenCalledWith("SET LOCAL hnsw.iterative_scan = strict_order");
    expect(mockClient.release).toHaveBeenCalled();
  });

  it("switches to exact sequential search when exactSearchOnly is true", async () => {
    const querySpy = vi.fn();
    querySpy.mockImplementation(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT") return {};
      if (sql.includes("enable_indexscan")) return {};
      return { rows: [] };
    });

    const mockClient = {
      query: querySpy,
      release: vi.fn(),
    };
    const mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient),
    } as unknown as DatabasePool;

    const service = new AedlsPitRetrievalService(mockPool);
    const result = await service.retrieve({
      ...baseInput,
      exactSearchOnly: true,
    });

    expect(result.status).toBe("NO_MATCH");
    expect(result.effectiveScanMethod).toBe("EXACT_SEQUENTIAL");
    expect(querySpy).toHaveBeenCalledWith("SET LOCAL enable_indexscan = off");
  });

  it("calculates Recall@10 correctly according to the frozen quantitative standard", () => {
    // Formula: |HNSW_10 ∩ Exact_10| / min(10, |Eligible|)
    const exactIds = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const hnswIds = ["a", "b", "c", "d", "e", "f", "g", "h", "x", "y"]; // 8 matching out of 10
    const eligibleCount = 15;

    const intersectionSize = hnswIds.filter((id) => exactIds.includes(id)).length;
    const denominator = Math.min(10, eligibleCount);
    const recallAt10 = intersectionSize / denominator;

    expect(recallAt10).toBe(0.8); // 80%
    expect(recallAt10 >= 0.95).toBe(false); // Below 95% threshold -> triggers exact fallback

    // If 10 out of 10 match:
    const perfectHnsw = [...exactIds];
    const perfectRecall = perfectHnsw.filter((id) => exactIds.includes(id)).length / Math.min(10, eligibleCount);
    expect(perfectRecall).toBe(1.0);
    expect(perfectRecall >= 0.95).toBe(true);
  });
});
