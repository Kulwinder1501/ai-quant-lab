import type { QueryResultRow } from "pg";
import type { DatabaseQueryable } from "../database.js";
import type {
  Instrument,
  InstrumentRepository,
  OptionType,
  UpsertInstrumentInput,
} from "../../../modules/market-data/domain/instrument.js";
import { fromDateColumn } from "../date-column.js";

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
  underlying_symbol: string | null;
  strike_price: string | null;
  expiry_date: Date | string | null;
  option_type: OptionType | null;
}

function toInstrument(row: InstrumentRow): Instrument {
  const expiry = row.expiry_date == null ? null : fromDateColumn(row.expiry_date).toISOString().slice(0, 10);
  return {
    id: row.id,
    exchange: row.exchange,
    symbol: row.symbol,
    displayName: row.display_name,
    instrumentType: row.instrument_type,
    isin: row.isin,
    tickSize: row.tick_size,
    lotSize: Number(row.lot_size),
    isActive: row.is_active,
    metadata: row.metadata,
    underlyingSymbol: row.underlying_symbol,
    strikePrice: row.strike_price === null ? null : Number(row.strike_price),
    expiryDate: expiry,
    optionType: row.option_type,
  };
}

const returningColumns = `
  id, exchange, symbol, display_name, instrument_type, isin,
  tick_size, lot_size, is_active, metadata,
  underlying_symbol, strike_price, expiry_date, option_type
`;

export class PostgresInstrumentRepository implements InstrumentRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async upsert(input: UpsertInstrumentInput): Promise<Instrument> {
    const result = await this.database.query<InstrumentRow>(`
      INSERT INTO instruments (
        exchange, symbol, display_name, instrument_type, isin, tick_size, lot_size, is_active, metadata,
        underlying_symbol, strike_price, expiry_date, option_type
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13)
      ON CONFLICT (exchange, symbol) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        instrument_type = EXCLUDED.instrument_type,
        isin = EXCLUDED.isin,
        tick_size = EXCLUDED.tick_size,
        lot_size = EXCLUDED.lot_size,
        is_active = EXCLUDED.is_active,
        metadata = EXCLUDED.metadata,
        underlying_symbol = EXCLUDED.underlying_symbol,
        strike_price = EXCLUDED.strike_price,
        expiry_date = EXCLUDED.expiry_date,
        option_type = EXCLUDED.option_type
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
      input.underlyingSymbol ?? null,
      input.strikePrice ?? null,
      input.expiryDate ?? null,
      input.optionType ?? null,
    ]);

    return toInstrument(result.rows[0]);
  }

  async findById(id: string): Promise<Instrument | null> {
    const result = await this.database.query<InstrumentRow>(`
      SELECT ${returningColumns} FROM instruments WHERE id = $1
    `, [id]);
    return result.rows[0] ? toInstrument(result.rows[0]) : null;
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
