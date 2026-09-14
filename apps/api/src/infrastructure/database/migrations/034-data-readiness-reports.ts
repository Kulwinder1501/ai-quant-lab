import type { Migration } from "../migration-runner.js";

/**
 * Persisted data-readiness audit reports (Phase 25, Workstream A).
 *
 * The audit is the phase's control panel: one machine-readable report per run,
 * measuring every stored candle series plus the institutional-flow context, and
 * assigning each series a READY / DEGRADED / STALE / INVALID state.
 *
 * It is stored — not just printed — because training must be able to prove which
 * audit it ran under. `train.py` reads the latest row, refuses to fit when the
 * series it is about to train on is not READY, and records the report id and hash
 * in the artifact's `validationProtocol.dataReadiness`. A research result whose
 * data health cannot be reproduced is not evidence.
 *
 * The report is immutable once written; a new audit inserts a new row. The hash
 * is a SHA-256 over the canonicalised report JSON, so two runs over identical
 * data produce different rows (different `generatedAt`) but comparable content
 * can still be diffed via the stored JSONB.
 */
export const dataReadinessReportsMigration: Migration = {
  id: "034-data-readiness-reports",
  sql: `
    CREATE TABLE IF NOT EXISTS data_readiness_reports (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      report_hash TEXT NOT NULL CHECK (length(trim(report_hash)) = 64),
      report JSONB NOT NULL CHECK (jsonb_typeof(report) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    -- Training reads only the most recent report; the audit history stays for
    -- the go/no-go audit trail Phase 25's definition of done requires.
    CREATE INDEX IF NOT EXISTS data_readiness_reports_latest_idx
    ON data_readiness_reports (created_at DESC);

    COMMENT ON TABLE data_readiness_reports IS
      'Machine-readable data-readiness audits. The latest row gates ML training; a series that is not READY must not be fitted.';
  `,
};
