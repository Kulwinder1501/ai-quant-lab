import type { QueryResultRow } from "pg";
import type { EnsureIndicatorDefinitionInput, IndicatorDefinition, IndicatorDefinitionRepository } from "../../../modules/technical-analysis/domain/technical-indicator.js";
import type { DatabaseQueryable } from "../database.js";

interface IndicatorDefinitionRow extends QueryResultRow {
  id: string;
  indicator_code: IndicatorDefinition["code"];
  algorithm_version: string;
  parameters: Record<string, unknown>;
  output_schema: Record<string, unknown>;
}

function toDefinition(row: IndicatorDefinitionRow): IndicatorDefinition {
  return {
    id: row.id,
    code: row.indicator_code,
    algorithmVersion: row.algorithm_version,
    parameters: row.parameters,
    outputSchema: row.output_schema,
  };
}

const returningColumns = "id, indicator_code, algorithm_version, parameters, output_schema";

export class PostgresIndicatorDefinitionRepository implements IndicatorDefinitionRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async ensure(input: EnsureIndicatorDefinitionInput): Promise<IndicatorDefinition> {
    const result = await this.database.query<IndicatorDefinitionRow>(`
      INSERT INTO indicator_definitions (
        indicator_code, algorithm_version, parameters, parameters_hash, output_schema
      ) VALUES ($1, $2, $3::jsonb, $4, $5::jsonb)
      ON CONFLICT (indicator_code, algorithm_version, parameters_hash) DO NOTHING
      RETURNING ${returningColumns}
    `, [
      input.code,
      input.algorithmVersion,
      JSON.stringify(input.parameters),
      input.parametersHash,
      JSON.stringify(input.outputSchema),
    ]);
    if (result.rows[0]) {
      return toDefinition(result.rows[0]);
    }
    const existing = await this.database.query<IndicatorDefinitionRow>(`
      SELECT ${returningColumns}
      FROM indicator_definitions
      WHERE indicator_code = $1 AND algorithm_version = $2 AND parameters_hash = $3
    `, [input.code, input.algorithmVersion, input.parametersHash]);
    if (!existing.rows[0]) {
      throw new Error(`Unable to resolve indicator definition ${input.code}.`);
    }
    return toDefinition(existing.rows[0]);
  }
}
