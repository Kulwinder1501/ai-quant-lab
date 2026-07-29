import type { QueryResultRow } from "pg";
import type {
  CreatePaperAccountInput,
  PaperAccount,
  PaperAccountRepository,
} from "../../../modules/paper-trading/domain/paper-trading.js";
import type { DatabaseQueryable } from "../database.js";

interface PaperAccountRow extends QueryResultRow {
  id: string;
  name: string;
  opening_balance: string;
  currency: "INR";
  is_active: boolean;
}

const accountColumns = "id, name, opening_balance, currency, is_active";

function toNumber(value: string, field: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Database returned an invalid numeric ${field}.`);
  }
  return parsed;
}

function toPaperAccount(row: PaperAccountRow): PaperAccount {
  return {
    id: row.id,
    name: row.name,
    openingBalance: toNumber(row.opening_balance, "opening balance"),
    currency: row.currency,
    isActive: row.is_active,
  };
}

/** Persists local INR simulation accounts only; it has no broker or payment integration. */
export class PostgresPaperAccountRepository implements PaperAccountRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async create(input: CreatePaperAccountInput): Promise<PaperAccount> {
    const result = await this.database.query<PaperAccountRow>(`
      INSERT INTO paper_accounts (name, opening_balance, currency, is_active)
      VALUES ($1, $2, 'INR', TRUE)
      RETURNING ${accountColumns}
    `, [input.name, input.openingBalance]);
    const account = result.rows[0];
    if (!account) {
      throw new Error("Paper account creation did not return a row.");
    }
    return toPaperAccount(account);
  }

  async findById(id: string): Promise<PaperAccount | null> {
    const result = await this.database.query<PaperAccountRow>(`
      SELECT ${accountColumns}
      FROM paper_accounts
      WHERE id = $1
    `, [id]);
    return result.rows[0] ? toPaperAccount(result.rows[0]) : null;
  }

  async findByName(name: string): Promise<PaperAccount | null> {
    const result = await this.database.query<PaperAccountRow>(`
      SELECT ${accountColumns}
      FROM paper_accounts
      WHERE name = $1
    `, [name]);
    return result.rows[0] ? toPaperAccount(result.rows[0]) : null;
  }
}
