/**
 * Interim / sample-rule review of MKT_CTX shadow vetoes on AutoBot-Sniper.
 *
 * Normative: docs/2026-10-13-market-context-observation-protocol.md §4
 *
 * Until 80 closed stamped trades with dq=PASS and ≥25 wouldBlock=true exist, prints
 * INCONCLUSIVE counts only — never a p-value or promotion recommendation.
 *
 * Usage (from apps/api): npx tsx scripts/review-mkt-ctx-shadow.ts
 */

import "dotenv/config";
import { loadEnvironment } from "../src/config/environment.js";
import { createDatabasePool } from "../src/infrastructure/database/database.js";

const SAMPLE_CLOSED_PASS = 80;
const SAMPLE_BLOCKED = 25;

interface Row {
  id: string;
  realized_pnl: string | null;
  initial_risk_distance: string | null;
  quantity: string | null;
  notes: string | null;
  opened_at: Date;
}

function extractMkt(notes: string | null): Record<string, unknown> | null {
  if (!notes) return null;
  const match = /MKT_CTX (\{.*?\})(?:\s|FRVP|$)/.exec(notes);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function plannedRisk(row: Row): number | null {
  const dist = Number(row.initial_risk_distance);
  const qty = Number(row.quantity);
  if (!(dist > 0) || !(qty > 0)) return null;
  return dist * qty;
}

async function main(): Promise<void> {
  const env = loadEnvironment(process.env);
  const database = createDatabasePool(env.DATABASE_URL);
  try {
    const result = await database.query<Row>(
      `SELECT t.id::text AS id, t.realized_pnl::text, t.initial_risk_distance::text,
              t.quantity::text, t.notes, t.opened_at
         FROM paper_trades t
         JOIN paper_accounts a ON a.id = t.account_id
        WHERE a.name = 'AutoBot-Sniper'
          AND t.notes LIKE '%MKT_CTX%'
          AND t.status = 'CLOSED'
          AND t.excluded_from_evidence = FALSE
        ORDER BY t.opened_at`,
    );

    let pass = 0;
    let blocked = 0;
    let allowed = 0;
    const blockedR: number[] = [];
    const allowedR: number[] = [];

    for (const row of result.rows) {
      const mkt = extractMkt(row.notes);
      if (!mkt || mkt.dq !== "PASS") continue;
      pass += 1;
      const risk = plannedRisk(row);
      const pnl = Number(row.realized_pnl);
      const r = risk && Number.isFinite(pnl) ? pnl / risk : null;
      if (mkt.wouldBlock === true) {
        blocked += 1;
        if (r !== null) blockedR.push(r);
      } else {
        allowed += 1;
        if (r !== null) allowedR.push(r);
      }
    }

    const sampleMet = pass >= SAMPLE_CLOSED_PASS && blocked >= SAMPLE_BLOCKED;
    const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);

    const report = {
      protocol: "mkt-ctx-v1",
      tradingExecutionAuthorized: false,
      nClosedWithStamp: result.rows.length,
      nPass: pass,
      nWouldBlock: blocked,
      nWouldAllow: allowed,
      sampleRule: { closedPass: SAMPLE_CLOSED_PASS, blocked: SAMPLE_BLOCKED, met: sampleMet },
      verdict: sampleMet ? "SAMPLE_MET_RUN_PERMUTATION_OFFLINE" : "INCONCLUSIVE_INTERIM_COUNTS_ONLY",
      meanNetR: {
        wouldBlock: mean(blockedR),
        wouldAllow: mean(allowedR),
      },
      note: sampleMet
        ? "Sample rule met: run the pre-registered day-clustered permutation test offline before any live gate."
        : "Do not promote shadow vetoes. Keep stamping.",
    };

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await database.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
