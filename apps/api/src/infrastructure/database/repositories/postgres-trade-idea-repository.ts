import type { QueryResultRow } from "pg";
import type {
  SaveTradeIdeaProposalInput,
  TradeIdea,
  TradeIdeaRepository,
  TradeIdeaStatus,
  TradeSide,
} from "../../../modules/strategy-engine/domain/strategy.js";
import type { DatabasePool } from "../database.js";

interface TradeIdeaRow extends QueryResultRow {
  id: string;
  instrument_id: string;
  strategy_version_id: string | null;
  source_candle_id: string | null;
  side: TradeSide;
  status: TradeIdeaStatus;
  entry_price: string;
  stop_loss: string;
  target_price: string;
  risk_reward: string;
  confidence: string;
  expires_at: Date | null;
}

const returningColumns = `
  id,
  instrument_id,
  strategy_version_id,
  source_candle_id,
  side,
  status,
  entry_price,
  stop_loss,
  target_price,
  risk_reward,
  confidence,
  expires_at
`;

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid numeric ${field}.`);
  }
  return parsed;
}

function toTradeIdea(row: TradeIdeaRow): TradeIdea {
  return {
    id: row.id,
    instrumentId: row.instrument_id,
    strategyVersionId: row.strategy_version_id,
    sourceCandleId: row.source_candle_id,
    side: row.side,
    status: row.status,
    entryPrice: toNumber(row.entry_price, "entry price"),
    stopLoss: toNumber(row.stop_loss, "stop loss"),
    targetPrice: toNumber(row.target_price, "target price"),
    riskReward: toNumber(row.risk_reward, "risk/reward"),
    confidence: toNumber(row.confidence, "confidence"),
    expiresAt: row.expires_at,
  };
}

/**
 * Keeps a retry of one strategy/candle/side proposal idempotent. Once a person
 * or another workflow changes its status, this repository returns that record
 * without changing the proposal or its evidence.
 */
export class PostgresTradeIdeaRepository implements TradeIdeaRepository {
  constructor(private readonly database: DatabasePool) {}

  async saveProposal(input: SaveTradeIdeaProposalInput): Promise<TradeIdea> {
    const client = await this.database.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      const upserted = await client.query<TradeIdeaRow>(`
        INSERT INTO trade_ideas (
          instrument_id,
          strategy_version_id,
          source_candle_id,
          side,
          status,
          entry_price,
          stop_loss,
          target_price,
          risk_reward,
          confidence,
          reasoning,
          evidence,
          expires_at
        ) VALUES (
          $1, $2, $3, $4, 'PROPOSED', $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12
        )
        ON CONFLICT (strategy_version_id, source_candle_id, side)
          WHERE strategy_version_id IS NOT NULL AND source_candle_id IS NOT NULL
        DO UPDATE SET
          entry_price = EXCLUDED.entry_price,
          stop_loss = EXCLUDED.stop_loss,
          target_price = EXCLUDED.target_price,
          risk_reward = EXCLUDED.risk_reward,
          confidence = EXCLUDED.confidence,
          reasoning = EXCLUDED.reasoning,
          evidence = EXCLUDED.evidence,
          generated_at = CURRENT_TIMESTAMP,
          expires_at = EXCLUDED.expires_at
        WHERE trade_ideas.status = 'PROPOSED'
        RETURNING ${returningColumns}
      `, [
        input.instrumentId,
        input.strategyVersionId,
        input.sourceCandleId,
        input.side,
        input.entryPrice,
        input.stopLoss,
        input.targetPrice,
        input.riskReward,
        input.confidence,
        JSON.stringify(input.reasoning),
        JSON.stringify(input.evidence),
        input.expiresAt,
      ]);

      const didCreateOrUpdateProposal = Boolean(upserted.rows[0]);
      let tradeIdea = upserted.rows[0];
      if (!tradeIdea) {
        const existing = await client.query<TradeIdeaRow>(`
          SELECT ${returningColumns}
          FROM trade_ideas
          WHERE strategy_version_id = $1
            AND source_candle_id = $2
            AND side = $3
          FOR UPDATE
        `, [input.strategyVersionId, input.sourceCandleId, input.side]);
        tradeIdea = existing.rows[0];
      }
      if (!tradeIdea) {
        throw new Error("Unable to resolve trade idea after proposal upsert.");
      }

      if (didCreateOrUpdateProposal) {
        await client.query("DELETE FROM trade_idea_evidence WHERE trade_idea_id = $1", [tradeIdea.id]);
        for (const [ordinal, evidence] of input.evidenceItems.entries()) {
          await client.query(`
            INSERT INTO trade_idea_evidence (
              trade_idea_id, ordinal, source_type, source_reference, label, contribution, details
            ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
          `, [
            tradeIdea.id,
            ordinal,
            evidence.sourceType,
            evidence.sourceReference,
            evidence.label,
            evidence.contribution,
            JSON.stringify(evidence.details),
          ]);
        }
      }

      await client.query("COMMIT");
      transactionStarted = false;
      return toTradeIdea(tradeIdea);
    } catch (error) {
      if (transactionStarted) {
        await client.query("ROLLBACK");
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
