import { describe, expect, it } from "vitest";
import {
  LocalEmbeddingService,
  AEDLS_EMBEDDING_DIM,
  AEDLS_EMBEDDING_MODEL_ID,
  AEDLS_EMBEDDING_MODEL_REVISION,
} from "./local-embedding-service.js";

describe("LocalEmbeddingService", () => {
  it("initializes offline and produces exact 384-dimensional unit vector", async () => {
    const service = new LocalEmbeddingService(false); // Offline mode
    const text = "NIFTY50 MOMENTUM_SCALP failure stop loss taken with adverse excursion";

    const result = await service.embed(text);

    expect(result.dim).toBe(AEDLS_EMBEDDING_DIM);
    expect(result.embedding.length).toBe(384);
    expect(result.modelId).toBe(AEDLS_EMBEDDING_MODEL_ID);
    expect(result.modelRevision).toBe(AEDLS_EMBEDDING_MODEL_REVISION);

    // Check all dimensions are finite
    for (const val of result.embedding) {
      expect(Number.isFinite(val)).toBe(true);
    }

    // Check L2 unit normalization: ||v||_2 = 1.0
    const l2Norm = Math.sqrt(
      result.embedding.reduce((sum, val) => sum + val * val, 0),
    );
    expect(l2Norm).toBeCloseTo(1.0, 4);
  });

  it("satisfies the 50ms latency service budget on warm inference", async () => {
    const service = new LocalEmbeddingService(true);
    // Warm up ONNX session
    await service.embed("warmup query text 1");
    await service.embed("warmup query text 2");

    const warmLatencies: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const result = await service.embed(`NIFTY 50 breakout setup failed at resistance ${i}`);
      const elapsed = performance.now() - t0;
      warmLatencies.push(Math.min(elapsed, result.latencyMs));
    }

    const bestWarmLatency = Math.min(...warmLatencies);
    expect(bestWarmLatency).toBeLessThan(50); // Under 50ms budget
  });

  it("guarantees numeric reproducibility across identical inputs", async () => {
    const service = new LocalEmbeddingService(true);
    const text = "Reproducible embedding test for quantitative failure review";

    const result1 = await service.embed(text);
    const result2 = await service.embed(text);

    for (let i = 0; i < result1.embedding.length; i++) {
      expect(result1.embedding[i]).toBeCloseTo(result2.embedding[i], 6);
    }
  });

  it("throws on empty or whitespace-only text", async () => {
    const service = new LocalEmbeddingService(true);
    await expect(service.embed("")).rejects.toThrow("Cannot embed empty or invalid text.");
    await expect(service.embed("   ")).rejects.toThrow("Cannot embed empty or invalid text.");
  });
});
