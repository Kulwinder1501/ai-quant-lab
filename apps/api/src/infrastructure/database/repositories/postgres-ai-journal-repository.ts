import { hostname } from "node:os";
import type { DatabasePool } from "../database.js";
import type {
  AiBrainThought,
  AiReflectionLog,
} from "../../../modules/strategy-engine/application/ai-autonomous-agent.js";
import type {
  EventTargetAssessment,
  ObservedEventEvidence,
  ObservedTradeEvent,
  TerminalTradeOutcome,
  OutcomeValidity,
  ExcursionValidity,
} from "../../../modules/strategy-engine/domain/aedls-forensic-review.js";

/** Recorded on each thought so "the agent was silent" and "nothing ticked it" stay distinguishable. */
const PROCESS_IDENTITY = `${hostname()}:${process.pid}`;

export interface ForensicReviewRecordInput {
  id: string;
  tradeId: string;
  candidateId?: string | null;
  symbol: string;
  side: "LONG" | "SHORT";
  setupFamily?: string | null;
  regimeClass?: string | null;
  pnl: number;
  outcome: "WIN" | "LOSS";
  analysis: string;
  improvementRule: string;
  structuralContext?: Record<string, unknown>;
  targetAssessments: readonly EventTargetAssessment[];
  observedEvents: readonly ObservedEventEvidence[];
  primaryObservedEvent?: ObservedTradeEvent | null;
  terminalOutcome?: TerminalTradeOutcome | null;
  outcomeValidity: OutcomeValidity;
  excursionValidity: ExcursionValidity;
  plannedRiskRupees?: number | null;
  realizedGrossRupees?: number | null;
  realizedNetRupees?: number | null;
  realizedGrossR?: number | null;
  realizedNetR?: number | null;
  mae3BarsR?: number | null;
  mfe3BarsR?: number | null;
  maxAdverseExcursionR?: number | null;
  maxFavourableExcursionR?: number | null;
  underlyingExcursionPoints?: number | null;
  causalHypothesis?: string | null;
  attributionStatus?: "SUPPORTED" | "REFUTED" | "UNKNOWN";
  tradeClosedAt: string;
  evidenceAvailableAt: string;
  reviewAvailableAt: string;
  embeddingAvailableAt?: string | null;
  reviewEmbeddingTemplateVersion?: string | null;
  embeddingModelId?: string | null;
  embeddingModelRevision?: string | null;
  embeddingConfigHash?: string | null;
  embeddingDim?: number | null;
  taxonomyVersion?: string | null;
  reviewerVersion?: string | null;
}

export class PostgresAiJournalRepository {
  constructor(private readonly pool: DatabasePool) {}

  /**
   * Persists one thought.
   *
   * Thoughts were in-memory only, which stopped working when the agent tick moved from the
   * dashboard's SSE handler to the scheduler: the API process that answers the dashboard no longer
   * produces them. See migration 052.
   *
   * `ON CONFLICT DO NOTHING` rather than an upsert. A thought is an observation made at an instant,
   * not a record to be revised, and its id already carries a timestamp -- a colliding id means the
   * same thought is being written twice, and keeping the first is correct.
   */
  public async saveThought(thought: AiBrainThought): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_brain_thoughts (
           id, timestamp, symbol, action, confidence, message, details, recorded_by
         ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
         ON CONFLICT (id) DO NOTHING`,
        [
          thought.id,
          thought.timestamp || new Date().toISOString(),
          thought.symbol,
          thought.action,
          thought.confidence,
          thought.message,
          JSON.stringify(thought.details ?? {}),
          PROCESS_IDENTITY,
        ],
      );
    } finally {
      client.release();
    }
  }

  /** Most recent thoughts first, optionally for one symbol. */
  public async getRecentThoughts(limit: number, symbol?: string): Promise<AiBrainThought[]> {
    const client = await this.pool.connect();
    try {
      const bounded = Math.max(1, Math.min(Math.trunc(limit), 500));
      const result = symbol
        ? await client.query(
          `SELECT id, timestamp, symbol, action, confidence, message, details
             FROM ai_brain_thoughts WHERE symbol = $2 ORDER BY timestamp DESC LIMIT $1`,
          [bounded, symbol.toUpperCase()],
        )
        : await client.query(
          `SELECT id, timestamp, symbol, action, confidence, message, details
             FROM ai_brain_thoughts ORDER BY timestamp DESC LIMIT $1`,
          [bounded],
        );
      return result.rows.map((row: Record<string, unknown>): AiBrainThought => ({
        id: String(row.id),
        timestamp: new Date(row.timestamp as string | Date).toISOString(),
        symbol: String(row.symbol),
        action: String(row.action) as AiBrainThought["action"],
        confidence: Number(row.confidence),
        message: String(row.message),
        details: (row.details ?? {}) as Record<string, unknown>,
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Saves a reflection with no embedding.
   *
   * `embedding` is left NULL rather than accepting a vector, because the only
   * vector this system could previously supply was a string hash. NULL states
   * truthfully that the row has not been embedded.
   */
  public async saveReflection(reflection: AiReflectionLog): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_journal_reflections (
          id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, timestamp
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9
        )
        ON CONFLICT (id) DO UPDATE SET
          analysis = EXCLUDED.analysis,
          improvement_rule = EXCLUDED.improvement_rule
        `,
        [
          reflection.id,
          reflection.tradeId,
          reflection.symbol,
          reflection.side,
          reflection.pnl,
          reflection.outcome,
          reflection.analysis,
          reflection.improvementRule,
          reflection.timestamp || new Date().toISOString(),
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Saves an auditable AEDLS forensic trade review into ai_journal_reflections.
   */
  public async saveForensicReview(input: ForensicReviewRecordInput): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query(
        `INSERT INTO ai_journal_reflections (
          id, trade_id, candidate_id, instrument_symbol, side, trade_side, setup_family, regime_class,
          pnl, outcome, analysis, improvement_rule,
          structural_context, target_assessments, observed_events, primary_observed_event,
          terminal_outcome, outcome_validity, excursion_validity,
          planned_risk_rupees, realized_gross_rupees, realized_net_rupees,
          realized_gross_r, realized_net_r,
          mae_3_bars_r, mfe_3_bars_r, max_adverse_excursion_r, max_favourable_excursion_r,
          underlying_excursion_points, causal_hypothesis, attribution_status,
          trade_closed_at, evidence_available_at, review_available_at, embedding_available_at,
          review_embedding_template_version, embedding_model_id, embedding_model_revision,
          embedding_config_hash, embedding_dim, taxonomy_version, reviewer_version, timestamp
        ) VALUES (
          $1, $2, $3, $4, $5, $5, $6, $7,
          $8, $9, $10, $11,
          $12::jsonb, $13::jsonb, $14::jsonb, $15,
          $16, $17, $18,
          $19, $20, $21,
          $22, $23,
          $24, $25, $26, $27,
          $28, $29, $30,
          $31, $32, $33, $34,
          $35, $36, $37,
          $38, $39, $40, $41, $31
        )
        -- P0.1 Invariant: Reviews are immutable once published.
        -- Idempotent creation: DO NOTHING on colliding review ID.
        ON CONFLICT (id) DO NOTHING
        `,
        [
          input.id,
          input.tradeId,
          input.candidateId ?? null,
          input.symbol,
          input.side,
          input.setupFamily ?? null,
          input.regimeClass ?? null,
          input.pnl,
          input.outcome,
          input.analysis,
          input.improvementRule,
          JSON.stringify(input.structuralContext ?? {}),
          JSON.stringify(input.targetAssessments),
          JSON.stringify(input.observedEvents),
          input.primaryObservedEvent ?? null,
          input.terminalOutcome ?? null,
          input.outcomeValidity,
          input.excursionValidity,
          input.plannedRiskRupees ?? null,
          input.realizedGrossRupees ?? null,
          input.realizedNetRupees ?? null,
          input.realizedGrossR ?? null,
          input.realizedNetR ?? null,
          input.mae3BarsR ?? null,
          input.mfe3BarsR ?? null,
          input.maxAdverseExcursionR ?? null,
          input.maxFavourableExcursionR ?? null,
          input.underlyingExcursionPoints ?? null,
          input.causalHypothesis ?? null,
          input.attributionStatus ?? "UNKNOWN",
          input.tradeClosedAt,
          input.evidenceAvailableAt,
          input.reviewAvailableAt,
          input.embeddingAvailableAt ?? null,
          input.reviewEmbeddingTemplateVersion ?? null,
          input.embeddingModelId ?? null,
          input.embeddingModelRevision ?? null,
          input.embeddingConfigHash ?? null,
          input.embeddingDim ?? 384,
          input.taxonomyVersion ?? null,
          input.reviewerVersion ?? null,
        ]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Attaches an embedding vector to an existing unembedded review.
   * P0.1 Invariant: Only succeeds if the review currently has no embedding (`embedding IS NULL`).
   * Forensic diagnosis, event labels, R measurements, and timestamps cannot be touched.
   */
  public async attachReviewEmbedding(input: {
    id: string;
    embedding: readonly number[];
    embeddingAvailableAt: string;
    reviewEmbeddingTemplateVersion: string;
    embeddingModelId: string;
    embeddingModelRevision: string;
    embeddingConfigHash: string;
    embeddingDim: 384;
  }): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const vectorLiteral = `[${input.embedding.join(",")}]`;
      const result = await client.query(
        `UPDATE ai_journal_reflections
         SET embedding = $2::vector,
             embedding_available_at = $3,
             review_embedding_template_version = $4,
             embedding_model_id = $5,
             embedding_model_revision = $6,
             embedding_config_hash = $7,
             embedding_dim = $8
         WHERE id = $1 AND embedding IS NULL`,
        [
          input.id,
          vectorLiteral,
          input.embeddingAvailableAt,
          input.reviewEmbeddingTemplateVersion,
          input.embeddingModelId,
          input.embeddingModelRevision,
          input.embeddingConfigHash,
          input.embeddingDim,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Removes any reflection already held for a trade.
   *
   * Reflection ids used to be `ref-<timestamp>-<random>`, so re-reviewing a trade
   * could not overwrite its earlier entry and the superseded text stayed on the
   * dashboard. Deleting by trade id rather than matching on the old wording is
   * deliberate: a text signature would be a heuristic, and this is exact.
   */
  public async deleteByTradeId(tradeId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("DELETE FROM ai_journal_reflections WHERE trade_id = $1", [tradeId]);
    } finally {
      client.release();
    }
  }

  public async getRecentReflections(limit: number): Promise<AiReflectionLog[]> {
    const client = await this.pool.connect();
    try {
      const res = await client.query(
        `SELECT id, trade_id, instrument_symbol, side, pnl, outcome, analysis, improvement_rule, timestamp
         FROM ai_journal_reflections
         ORDER BY timestamp DESC
         LIMIT $1`,
        [limit]
      );
      
      return res.rows.map((row: any) => ({
        id: row.id,
        timestamp: new Date(row.timestamp).toISOString(),
        tradeId: row.trade_id,
        symbol: row.instrument_symbol,
        side: row.side as "LONG" | "SHORT",
        pnl: Number(row.pnl),
        outcome: row.outcome as "WIN" | "LOSS",
        analysis: row.analysis,
        improvementRule: row.improvement_rule,
      }));
    } finally {
      client.release();
    }
  }
}

