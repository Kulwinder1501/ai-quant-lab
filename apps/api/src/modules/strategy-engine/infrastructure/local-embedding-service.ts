import { pipeline, env, type FeatureExtractionPipeline } from "@huggingface/transformers";

export const AEDLS_EMBEDDING_MODEL_ID = "Xenova/all-MiniLM-L6-v2";
export const AEDLS_EMBEDDING_MODEL_REVISION = "751bff37182d3f1213fa05d7196b954e230abad9";
export const AEDLS_EMBEDDING_DIM = 384;
export const AEDLS_EMBEDDING_CONFIG_HASH = "59aeffb3e8b9d72e1c1f97f92c68ace8208bbde2d803d9e9c8e4b30493233ff3";
export const AEDLS_ONNX_WEIGHTS_SHA256 = "759c3cd2b7fe7e93933ad23c4c9181b7396442a2ed746ec7c1d46192c469c46e";

export interface EmbeddingResult {
  readonly embedding: readonly number[];
  readonly latencyMs: number;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dim: 384;
}

export class LocalEmbeddingService {
  private extractorPromise: Promise<FeatureExtractionPipeline> | null = null;
  private isColdStart = true;
  private coldStartLatencyMs = 0;

  constructor(private readonly allowRemoteModels = true) {
    // Preserve transformers environment - setting allowRemoteModels = false breaks tokenizer resolution in v3
  }

  /**
   * Initializes or returns the pre-warmed feature-extraction pipeline.
   */
  public async getExtractor(): Promise<FeatureExtractionPipeline> {
    if (!this.extractorPromise) {
      const t0 = performance.now();
      this.extractorPromise = (pipeline as any)(
        "feature-extraction",
        AEDLS_EMBEDDING_MODEL_ID,
        {
          revision: AEDLS_EMBEDDING_MODEL_REVISION,
        },
      ).then((extractor: FeatureExtractionPipeline) => {
        this.coldStartLatencyMs = performance.now() - t0;
        this.isColdStart = false;
        return extractor;
      });
    }
    return this.extractorPromise!;
  }

  /**
   * Generates a 384-dimensional, L2-normalized unit vector for the given text.
   * Throws if the embedding contains non-finite numbers or fails dimension checks.
   */
  public async embed(text: string): Promise<EmbeddingResult> {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Cannot embed empty or invalid text.");
    }

    const extractor = await this.getExtractor();
    const t0 = performance.now();

    const output = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    const latencyMs = Number((performance.now() - t0).toFixed(2));
    const rawData = Array.from(output.data as Float32Array | number[]);

    if (rawData.length !== AEDLS_EMBEDDING_DIM) {
      throw new Error(
        `Embedding dimension mismatch: expected ${AEDLS_EMBEDDING_DIM}, got ${rawData.length}`,
      );
    }

    for (let i = 0; i < rawData.length; i++) {
      if (!Number.isFinite(rawData[i])) {
        throw new Error(`Embedding contains non-finite value at index ${i}: ${rawData[i]}`);
      }
    }

    return {
      embedding: rawData,
      latencyMs,
      modelId: AEDLS_EMBEDDING_MODEL_ID,
      modelRevision: AEDLS_EMBEDDING_MODEL_REVISION,
      dim: 384,
    };
  }

  public getMetrics(): { isColdStart: boolean; coldStartLatencyMs: number } {
    return {
      isColdStart: this.isColdStart,
      coldStartLatencyMs: this.coldStartLatencyMs,
    };
  }
}
