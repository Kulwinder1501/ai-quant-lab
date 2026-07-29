import type { QueryResultRow } from "pg";
import type { MarketDataIngestion, MarketDataIngestionRepository, StartMarketDataIngestionInput } from "../../../modules/market-data/domain/market-data-ingestion.js";
import type { DatabaseQueryable } from "../database.js";

interface MarketDataIngestionRow extends QueryResultRow {
  id: string;
  provider: string;
  mode: "HISTORICAL" | "LIVE";
  status: MarketDataIngestion["status"];
  record_count: number;
  started_at: Date;
  completed_at: Date | null;
  error_message: string | null;
}

const returningColumns = "id, provider, mode, status, record_count, started_at, completed_at, error_message";

function toIngestion(row: MarketDataIngestionRow): MarketDataIngestion {
  return {
    id: row.id,
    provider: row.provider,
    mode: row.mode,
    status: row.status,
    recordCount: row.record_count,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    errorMessage: row.error_message,
  };
}

export class PostgresMarketDataIngestionRepository implements MarketDataIngestionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async start(input: StartMarketDataIngestionInput): Promise<MarketDataIngestion> {
    const result = await this.database.query<MarketDataIngestionRow>(`
      INSERT INTO market_data_ingestions (provider, mode, request_metadata)
      VALUES ($1, $2, $3::jsonb)
      RETURNING ${returningColumns}
    `, [input.provider, input.mode, JSON.stringify(input.requestMetadata)]);
    return toIngestion(result.rows[0]);
  }

  async complete(id: string, recordCount: number): Promise<MarketDataIngestion> {
    const result = await this.database.query<MarketDataIngestionRow>(`
      UPDATE market_data_ingestions
      SET status = 'COMPLETED', record_count = $2, completed_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'RUNNING'
      RETURNING ${returningColumns}
    `, [id, recordCount]);
    if (!result.rows[0]) {
      throw new Error(`Cannot complete market-data ingestion ${id}.`);
    }
    return toIngestion(result.rows[0]);
  }

  async fail(id: string, errorMessage: string): Promise<MarketDataIngestion> {
    const result = await this.database.query<MarketDataIngestionRow>(`
      UPDATE market_data_ingestions
      SET status = 'FAILED', error_message = $2, completed_at = CURRENT_TIMESTAMP
      WHERE id = $1 AND status = 'RUNNING'
      RETURNING ${returningColumns}
    `, [id, errorMessage.slice(0, 4_000)]);
    if (!result.rows[0]) {
      throw new Error(`Cannot fail market-data ingestion ${id}.`);
    }
    return toIngestion(result.rows[0]);
  }
}
