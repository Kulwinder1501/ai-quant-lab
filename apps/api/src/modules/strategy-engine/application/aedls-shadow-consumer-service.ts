import type { DatabasePool } from "../../../infrastructure/database/database.js";
import {
  LocalEmbeddingService,
  AEDLS_EMBEDDING_MODEL_ID,
  AEDLS_EMBEDDING_MODEL_REVISION,
} from "../infrastructure/local-embedding-service.js";
import { AedlsPitRetrievalService } from "./aedls-pit-retrieval-service.js";

export const AEDLS_CANDIDATE_QUERY_TEMPLATE_VERSION = "candidate-query-v2.7";

export interface CandidateDecisionShadowInput {
  readonly candidateDecisionId: string;
  readonly tradeIdeaId: string;
  readonly decidedAt: Date;
}

export interface CandidateContextRow {
  readonly symbol: string;
  readonly side: "LONG" | "SHORT";
  readonly strategy_name: string;
}

/**
 * Asynchronous advisory consumer for AEDLS Phase 3 Stage A telemetry.
 *
 * Listens to candidate decisions, runs PIT vector retrieval against past failure memories,
 * and emits an immutable recommendation record to aedls_shadow_recommendations.
 *
 * HARD INVARIANTS:
 * 1. applied_confidence_delta is strictly 0 at all times (guaranteed by DB CHECK constraint).
 * 2. Zero effect on execution path or order routing.
 * 3. Never throws to caller -- any error is caught and logged as OPERATIONAL_FALLBACK.
 */
export class AedlsShadowConsumerService {
  private embedder: LocalEmbeddingService;
  private retrievalService: AedlsPitRetrievalService;

  constructor(
    private readonly pool: DatabasePool,
    embedder?: LocalEmbeddingService,
    retrievalService?: AedlsPitRetrievalService,
  ) {
    this.embedder = embedder ?? new LocalEmbeddingService(true);
    this.retrievalService = retrievalService ?? new AedlsPitRetrievalService(pool);
  }

  public async processCandidateDecision(input: CandidateDecisionShadowInput): Promise<void> {
    const decidedAt = input.decidedAt instanceof Date ? input.decidedAt : new Date(input.decidedAt);

    try {
      // 1. Fetch trade idea and instrument metadata
      const contextRes = await this.pool.query<CandidateContextRow>(
        `
        SELECT 
          i.symbol,
          ti.side,
          COALESCE(s.name, 'MOMENTUM_SCALP') AS strategy_name
        FROM trade_ideas ti
        JOIN instruments i ON i.id = ti.instrument_id
        LEFT JOIN strategy_versions sv ON sv.id = ti.strategy_version_id
        LEFT JOIN strategies s ON s.id = sv.strategy_id
        WHERE ti.id = $1
        LIMIT 1
      `,
        [input.tradeIdeaId],
      );

      const context = contextRes.rows[0];
      if (!context) {
        // Trade idea not found in DB yet: emit unindexed fallback
        await this.emitFallback(input.candidateDecisionId, input.tradeIdeaId, decidedAt, [
          "TRADE_IDEA_METADATA_UNAVAILABLE",
        ]);
        return;
      }

      const instrumentSymbol = context.symbol === "NSE:NIFTYBANK-INDEX" ? "BANKNIFTY"
        : context.symbol === "NSE:NIFTY50-INDEX" ? "NIFTY50"
        : context.symbol.replace("NSE:", "").replace("-INDEX", "");
      const tradeSide = context.side === "SHORT" ? "SHORT" : "LONG";
      const setupFamily = context.strategy_name || "MOMENTUM_SCALP";
      const regimeClass = "TRENDING";

      // 2. Build candidate query representation and embed
      const queryText = `${instrumentSymbol} ${tradeSide} ${setupFamily} candidate at ${decidedAt.toISOString()}`;
      const embResult = await this.embedder.embed(queryText);

      // 3. Query PIT retrieval service against failure memory corpus
      const retrievalResult = await this.retrievalService.retrieve({
        queryEmbedding: embResult.embedding,
        decisionAt: decidedAt,
        instrumentSymbol,
        tradeSide,
        setupFamily,
        regimeClass,
        queryFamily: "FAILURE_RISK_EXP_B",
        cohortFilter: "EVENT_POSITIVE",
        similarityFloor: 0.70,
        limit: 5,
        exactSearchOnly: false,
      });

      const matches = retrievalResult.records;

      // 4. Classify hypothetical advisory decision
      let hypotheticalAdmissionDecision: "ADMIT" | "REJECT" = "ADMIT";
      let proposedConfidenceDelta: number | null = 0;
      const reasonCodes: string[] = [];
      let status = "NORMAL_ADMISSION";

      // Check if any retrieved memory experienced an IMMEDIATE_ADVERSE_EXCURSION
      const adverseExcursionMatch = matches.find((m) =>
        m.targetAssessments?.some(
          (ta: any) =>
            ta?.targetEvent === "IMMEDIATE_ADVERSE_EXCURSION" &&
            (ta?.label === "POSITIVE" || ta?.evidenceStatus === "TICK_VERIFIED"),
        ),
      );

      if (adverseExcursionMatch) {
        hypotheticalAdmissionDecision = "REJECT";
        proposedConfidenceDelta = -0.25;
        reasonCodes.push("SIMILAR_PAST_ADVERSE_EXCURSION");
        reasonCodes.push(`matched_review_id=${adverseExcursionMatch.id}`);
        reasonCodes.push(`similarity=${adverseExcursionMatch.semanticSimilarity.toFixed(4)}`);
        status = "ADVISORY_REJECT_PROPOSED";
      } else if (matches.length > 0) {
        hypotheticalAdmissionDecision = "ADMIT";
        proposedConfidenceDelta = 0.0;
        reasonCodes.push("SIMILAR_HISTORICAL_MATCHES_BENIGN");
        status = "ADVISORY_ADMIT";
      } else {
        hypotheticalAdmissionDecision = "ADMIT";
        proposedConfidenceDelta = 0.0;
        reasonCodes.push("NO_SIMILAR_FAILURE_MEMORY");
        status = "FALLBACK_PRIOR";
      }

      // 5. Emit immutable recommendation record to aedls_shadow_recommendations
      await this.pool.query(
        `
        INSERT INTO aedls_shadow_recommendations (
          candidate_decision_id,
          candidate_id,
          decided_at,
          hypothetical_admission_decision,
          applied_confidence_delta,
          proposed_confidence_delta,
          reason_codes,
          status,
          candidate_query_template_version,
          embedding_model_id,
          embedding_model_revision
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          $4,
          0,
          $5,
          $6::jsonb,
          $7,
          $8,
          $9,
          $10
        )
      `,
        [
          input.candidateDecisionId,
          input.tradeIdeaId,
          decidedAt,
          hypotheticalAdmissionDecision,
          proposedConfidenceDelta,
          JSON.stringify(reasonCodes),
          status,
          AEDLS_CANDIDATE_QUERY_TEMPLATE_VERSION,
          AEDLS_EMBEDDING_MODEL_ID,
          AEDLS_EMBEDDING_MODEL_REVISION,
        ],
      );
    } catch (err) {
      // Fallback: log operational issue without failing caller
      await this.emitFallback(input.candidateDecisionId, input.tradeIdeaId, decidedAt, [
        "OPERATIONAL_FALLBACK",
        err instanceof Error ? err.message : String(err),
      ]);
    }
  }

  private async emitFallback(
    candidateDecisionId: string,
    candidateId: string,
    decidedAt: Date,
    reasonCodes: string[],
  ): Promise<void> {
    try {
      await this.pool.query(
        `
        INSERT INTO aedls_shadow_recommendations (
          candidate_decision_id,
          candidate_id,
          decided_at,
          hypothetical_admission_decision,
          applied_confidence_delta,
          proposed_confidence_delta,
          reason_codes,
          status,
          candidate_query_template_version,
          embedding_model_id,
          embedding_model_revision
        ) VALUES (
          $1::uuid,
          $2::uuid,
          $3,
          'ADMIT',
          0,
          NULL,
          $4::jsonb,
          'MODEL_UNAVAILABLE',
          $5,
          $6,
          $7
        )
      `,
        [
          candidateDecisionId,
          candidateId,
          decidedAt,
          JSON.stringify(reasonCodes),
          AEDLS_CANDIDATE_QUERY_TEMPLATE_VERSION,
          AEDLS_EMBEDDING_MODEL_ID,
          AEDLS_EMBEDDING_MODEL_REVISION,
        ],
      );
    } catch (err) {
      console.error("AEDLS emitFallback write failed:", err);
    }
  }
}
