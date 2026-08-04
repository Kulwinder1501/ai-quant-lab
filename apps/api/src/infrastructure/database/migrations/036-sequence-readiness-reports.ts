import type { Migration } from "../migration-runner.js";

export const sequenceReadinessReportsMigration: Migration = {
  id: "036-sequence-readiness-reports",
  sql: `
    CREATE TABLE IF NOT EXISTS sequence_readiness_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_hash TEXT NOT NULL CHECK (length(trim(report_hash)) = 64),
      report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS sequence_readiness_reports_latest_idx
    ON sequence_readiness_reports (created_at DESC);

    COMMENT ON TABLE sequence_readiness_reports IS
      'Phase 25 Workstream D/E: TCN sequence-readiness gate reports. A PASS opens research for that candidate; FAIL/BLOCKED must not authorize Stage 5 training.';
  `,
};
