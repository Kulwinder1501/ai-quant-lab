import type { DatabasePool } from "../../../infrastructure/database/database.js";
import {
  AEDLS_EMBEDDING_MODEL_ID,
  AEDLS_EMBEDDING_MODEL_REVISION,
  AEDLS_EMBEDDING_CONFIG_HASH,
  AEDLS_EMBEDDING_DIM,
} from "../infrastructure/local-embedding-service.js";

export type PitQueryFamily = "FAILURE_RISK_EXP_B" | "RETURN_DIAGNOSTICS_EXP_A";

export type PitCohortFilter =
  | "EVENT_POSITIVE"
  | "EVENT_NEGATIVE_CONTROL"
  | "PROFITABLE"
  | "UNPROFITABLE";

export interface PitRetrievalQueryInput {
  readonly instrumentSymbol: string;
  readonly tradeSide: "LONG" | "SHORT";
  readonly setupFamily: string;
  readonly regimeClass: string;
  readonly decisionAt: Date;
  readonly queryEmbedding: readonly number[];
  readonly queryFamily: PitQueryFamily;
  readonly cohortFilter: PitCohortFilter;
  readonly similarityFloor?: number;
  readonly limit?: number;
  readonly exactSearchOnly?: boolean;
}

export interface PitRetrievalRecord {
  readonly id: string;
  readonly tradeId: string;
  readonly candidateId: string | null;
  readonly semanticSimilarity: number;
  readonly realizedNetR: number | null;
  readonly targetAssessments: unknown[];
  readonly structuralContext: Record<string, unknown>;
}

export interface PitRetrievalResult {
  readonly status: "MATCH_VALIDATED" | "NO_MATCH" | "MODEL_UNAVAILABLE";
  readonly records: readonly PitRetrievalRecord[];
  readonly rawCount: number;
  readonly deduplicatedEpisodeCount: number;
  readonly queryLatencyMs: number;
  readonly effectiveScanMethod: "HNSW" | "EXACT_SEQUENTIAL";
  readonly decisionAt: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly reasonCodes: readonly string[];
}

export class AedlsPitRetrievalService {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Executes a strict Point-in-Time pre-filtered vector retrieval query.
   * Completely read-only: never modifies the candidate ledger or affects order routing.
   * If the vector store times out or fails, returns status: "MODEL_UNAVAILABLE".
   */
  public async retrieve(input: PitRetrievalQueryInput): Promise<PitRetrievalResult> {
    const t0 = performance.now();
    const similarityFloor = input.similarityFloor ?? 0.7;
    const limit = input.limit ?? 10;
    const decisionAtIso = input.decisionAt.toISOString();
    const vectorLiteral = `[${input.queryEmbedding.join(",")}]`;
    const exactSearchOnly = input.exactSearchOnly ?? true;

    if (input.queryEmbedding.length !== AEDLS_EMBEDDING_DIM) {
      return {
        status: "MODEL_UNAVAILABLE",
        records: [],
        rawCount: 0,
        deduplicatedEpisodeCount: 0,
        queryLatencyMs: Number((performance.now() - t0).toFixed(2)),
        effectiveScanMethod: exactSearchOnly ? "EXACT_SEQUENTIAL" : "HNSW",
        decisionAt: decisionAtIso,
        modelId: AEDLS_EMBEDDING_MODEL_ID,
        modelRevision: AEDLS_EMBEDDING_MODEL_REVISION,
        reasonCodes: [`INVALID_EMBEDDING_DIMENSION_${input.queryEmbedding.length}`],
      };
    }

    const client = await this.pool.connect();
    try {
      // Transaction block with SET LOCAL for query-scoped index settings
      await client.query("BEGIN");

      if (exactSearchOnly) {
        await client.query("SET LOCAL enable_indexscan = off");
        await client.query("SET LOCAL enable_bitmapscan = off");
      } else {
        await client.query("SET LOCAL hnsw.ef_search = 100");
        await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
      }

      let cohortPredicate = "";
      if (input.cohortFilter === "EVENT_POSITIVE") {
        cohortPredicate = `
          AND (
            r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
            OR
            r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "POSITIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
          )
        `;
      } else if (input.cohortFilter === "EVENT_NEGATIVE_CONTROL") {
        cohortPredicate = `
          AND (
            r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "TICK_VERIFIED"}]'::jsonb
            OR
            r.target_assessments @> '[{"targetEvent": "IMMEDIATE_ADVERSE_EXCURSION", "label": "NEGATIVE", "evidenceStatus": "BAR_DERIVED_UNAMBIGUOUS"}]'::jsonb
          )
        `;
      } else if (input.cohortFilter === "PROFITABLE") {
        cohortPredicate = `
          AND r.outcome_validity = 'VALID_RECONCILED'
          AND r.realized_net_r > 0
        `;
      } else if (input.cohortFilter === "UNPROFITABLE") {
        cohortPredicate = `
          AND r.outcome_validity = 'VALID_RECONCILED'
          AND r.realized_net_r <= 0
        `;
      }

      const sql = `
        SELECT 
            r.id,
            r.trade_id,
            r.candidate_id,
            r.target_assessments,
            r.structural_context,
            r.realized_net_r,
            1 - (r.embedding <=> $1::vector) AS semantic_similarity
        FROM ai_journal_reflections r
        WHERE r.trade_closed_at < $2
          AND r.evidence_available_at < $2
          AND r.review_available_at < $2
          AND r.embedding_available_at < $2
          AND r.embedding IS NOT NULL
          -- Embedding Provenance Compatibility Guard:
          AND r.embedding_model_id = $3
          AND r.embedding_model_revision = $4
          AND r.embedding_config_hash = $5
          AND r.embedding_dim = 384
          -- Structural Pre-Filtering:
          AND r.instrument_symbol = $6
          AND r.trade_side = $7
          AND r.setup_family = $8
          AND r.regime_class = $9
          ${cohortPredicate}
          -- Calibrated Similarity Floor:
          AND 1 - (r.embedding <=> $1::vector) >= $10
        ORDER BY r.embedding <=> $1::vector ASC
        LIMIT $11;
      `;

      const params = [
        vectorLiteral,
        decisionAtIso,
        AEDLS_EMBEDDING_MODEL_ID,
        AEDLS_EMBEDDING_MODEL_REVISION,
        AEDLS_EMBEDDING_CONFIG_HASH,
        input.instrumentSymbol,
        input.tradeSide,
        input.setupFamily,
        input.regimeClass,
        similarityFloor,
        limit,
      ];

      const res = await client.query(sql, params);
      await client.query("COMMIT");

      const records: PitRetrievalRecord[] = res.rows.map((row: any) => ({
        id: String(row.id),
        tradeId: String(row.trade_id),
        candidateId: row.candidate_id ? String(row.candidate_id) : null,
        semanticSimilarity: Number(Number(row.semantic_similarity).toFixed(6)),
        realizedNetR: row.realized_net_r !== null ? Number(row.realized_net_r) : null,
        targetAssessments: Array.isArray(row.target_assessments) ? row.target_assessments : [],
        structuralContext: (row.structural_context ?? {}) as Record<string, unknown>,
      }));

      // Deduplicate continuous episodes
      const uniqueTrades = new Set(records.map((r) => r.tradeId));
      const deduplicatedEpisodeCount = uniqueTrades.size;

      const queryLatencyMs = Number((performance.now() - t0).toFixed(2));
      const status = records.length > 0 ? "MATCH_VALIDATED" : "NO_MATCH";

      return {
        status,
        records,
        rawCount: records.length,
        deduplicatedEpisodeCount,
        queryLatencyMs,
        effectiveScanMethod: exactSearchOnly ? "EXACT_SEQUENTIAL" : "HNSW",
        decisionAt: decisionAtIso,
        modelId: AEDLS_EMBEDDING_MODEL_ID,
        modelRevision: AEDLS_EMBEDDING_MODEL_REVISION,
        reasonCodes: records.length > 0 ? [`FOUND_${records.length}_SIMILAR_PATTERNS`] : ["NO_MATCH_ABOVE_FLOOR"],
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Ignore rollback failure if connection was lost
      }

      return {
        status: "MODEL_UNAVAILABLE",
        records: [],
        rawCount: 0,
        deduplicatedEpisodeCount: 0,
        queryLatencyMs: Number((performance.now() - t0).toFixed(2)),
        effectiveScanMethod: input.exactSearchOnly ? "EXACT_SEQUENTIAL" : "HNSW",
        decisionAt: decisionAtIso,
        modelId: AEDLS_EMBEDDING_MODEL_ID,
        modelRevision: AEDLS_EMBEDDING_MODEL_REVISION,
        reasonCodes: [
          "RETRIEVAL_INFRASTRUCTURE_FAILURE",
          error instanceof Error ? error.message : String(error),
        ],
      };
    } finally {
      client.release();
    }
  }
}
