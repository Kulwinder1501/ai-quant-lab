import type { Migration } from "../migration-runner.js";

/**
 * Gate 7 formal acceptance reports. Append-only so a later re-run cannot
 * rewrite an earlier fail/pass. Enablement still reads env flags, not this table.
 */
export const stockIntelligenceGate7ReportMigration: Migration = {
  id: "104-stock-intelligence-gate7-reports",
  sql: `
    CREATE TABLE stock_intelligence.gate7_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      job_id UUID NOT NULL REFERENCES stock_intelligence.replay_jobs(id) ON DELETE RESTRICT,
      evaluation_as_of DATE NOT NULL,
      horizon TEXT NOT NULL CHECK (horizon IN ('6M', '12M')),
      passed BOOLEAN NOT NULL,
      payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      published_at TIMESTAMPTZ NOT NULL,
      effective_at TIMESTAMPTZ NOT NULL,
      available_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CHECK (published_at <= available_at)
    );
    CREATE INDEX stock_intelligence_gate7_job_idx
      ON stock_intelligence.gate7_reports (job_id, horizon, available_at DESC);

    CREATE TRIGGER reject_mutation_gate7_reports
      BEFORE UPDATE OR DELETE ON stock_intelligence.gate7_reports
      FOR EACH ROW EXECUTE FUNCTION stock_intelligence.reject_mutation();
  `,
};
