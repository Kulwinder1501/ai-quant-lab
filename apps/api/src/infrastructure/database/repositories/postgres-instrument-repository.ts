import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import type { Instrument, InstrumentRepository, UpsertInstrumentInput } from "../../../modules/market-data/domain/instrument.js";

interface InstrumentRow extends QueryResultRow {
  id: string;
  exchange: Instrument["exchange"];
  symbol: string;
  display_name: string;
  instrument_type: Instrument["instrumentType"];
  isin: string | null;
  tick_size: string;
  lot_size: number;
  is_active: boolean;
  metadata: Record<string, unknown>;
}

function toInstrument(row: InstrumentRow): Instrument {
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    displayName: row.display_name,
    instrumentType: row.instrument_type,
    isin: row.isin,
    tickSize: row.tick_size,
    lotSize: row.lot_size,
    isActive: row.is_active,
    metadata: row.metadata,
  };
}

const returningColumns = `
  id, exchange, symbol, display_name, instrument_type, isin,
  tick_size, lot_size, is_active, metadata
`;

export class PostgresInstrumentRepository implements InstrumentRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: UpsertInstrumentInput): Promise<Instrument> {
    const result = await this.database.query<InstrumentRow>(`
      INSERT INTO instruments (
        exchange, symbol, display_name, instrument_type, isin, tick_size, lot_size, is_active, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      ON CONFLICT (exchange, symbol) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        instrument_type = EXCLUDED.instrument_type,
        isin = EXCLUDED.isin,
        tick_size = EXCLUDED.tick_size,
        lot_size = EXCLUDED.lot_size,
        is_active = EXCLUDED.is_active,
        metadata = EXCLUDED.metadata
      RETURNING ${returningColumns}
    `, [
      input.exchange,
      input.symbol.trim().toUpperCase(),
      input.displayName.trim(),
      input.instrumentType,
      input.isin ?? null,
      input.tickSize ?? "0.05",
      input.lotSize ?? 1,
      input.isActive ?? true,
      JSON.stringify(input.metadata ?? {}),
    ]);

    return toInstrument(result.rows[0]);
  }

  async findByExchangeAndSymbol(exchange: Instrument["exchange"], symbol: string): Promise<Instrument | null> {
    const result = await this.database.query<InstrumentRow>(`
      SELECT ${returningColumns} FROM instruments WHERE exchange = $1 AND symbol = $2
    `, [exchange, symbol.trim().toUpperCase()]);
    return result.rows[0] ? toInstrument(result.rows[0]) : null;
  }

  async listActive(): Promise<Instrument[]> {
    const result = await this.database.query<InstrumentRow>(`
      SELECT ${returningColumns} FROM instruments WHERE is_active = TRUE ORDER BY exchange, symbol
    `);
    return result.rows.map(toInstrument);
  }
}
