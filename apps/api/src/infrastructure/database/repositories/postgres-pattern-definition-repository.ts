import type { QueryResultRow } from "pg";
import type { PatternDefinition, PatternDefinitionRepository } from "../../../modules/pattern-recognition/domain/market-pattern.js";
import type { DatabaseQueryable } from "../database.js";

interface PatternDefinitionRow extends QueryResultRow {
  id: string;
  pattern_code: PatternDefinition["code"];
  algorithm_version: string;
}

function toDefinition(row: PatternDefinitionRow): PatternDefinition {
  return {
    id: row.id,
    code: row.pattern_code,
    algorithmVersion: row.algorithm_version,
  };
}

const returningColumns = "id, pattern_code, algorithm_version";

export class PostgresPatternDefinitionRepository implements PatternDefinitionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async ensure(input: { code: PatternDefinition["code"]; algorithmVersion: string; description: string }): Promise<PatternDefinition> {
    const result = await this.database.query<PatternDefinitionRow>(`
      INSERT INTO pattern_definitions (
        pattern_code, category, algorithm_version, description
      ) VALUES ($1, 'CANDLESTICK', $2, $3)
      ON CONFLICT (pattern_code, algorithm_version) DO NOTHING
      RETURNING ${returningColumns}
    `, [input.code, input.algorithmVersion, input.description]);
    if (result.rows[0]) {
      return toDefinition(result.rows[0]);
    }

    const existing = await this.database.query<PatternDefinitionRow>(`
      SELECT ${returningColumns}
      FROM pattern_definitions
      WHERE pattern_code = $1 AND algorithm_version = $2
    `, [input.code, input.algorithmVersion]);
    if (!existing.rows[0]) {
      throw new Error(`Unable to resolve pattern definition ${input.code}.`);
    }
    return toDefinition(existing.rows[0]);
  }
}
