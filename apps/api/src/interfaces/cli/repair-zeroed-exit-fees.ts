import "dotenv/config";
import { loadEnvironment } from "../../config/environment.js";
import { createDatabasePool } from "../../infrastructure/database/database.js";
import { calculateExitFees } from "../../modules/paper-trading/domain/brokerage-calculator.js";

/**
 * Repairs the closes that never charged exit brokerage.
 *
 * `paper:trades:evaluate` passed `exitFees: 0` whenever `--exit-fees` was absent, and the
 * evaluator resolves `explicitExitFees ?? calculateExitFees(...)` -- so an explicit 0 suppressed
 * the calculation. The scheduler ran that CLI every minute per account with no flag, so whichever
 * process won the race to close a position decided whether it paid brokerage. Fixed forward in
 * bc0b4f8; this repairs the rows already written.
 *
 * ## The discriminator
 *
 * An exit breakdown of exactly `{"total": 0}` -- a bare total with no component fields. The
 * repository writes that shape only when `feeBreakdown` is undefined, which happens only when the
 * caller supplied the fee. A genuinely free exit is different: `breakdownFees` with zero turnover
 * returns a *full* object whose components are all zero, and an expired-worthless option takes
 * that path. Verified on this database: 56 rows match, 0 have a computed zero, none are EXPIRED,
 * and all 56 have a positive exit price, so every one is a real sale that should have been charged.
 *
 * Naturally idempotent: a repaired row carries a full breakdown and no longer matches.
 *
 * ## What is written
 *
 * Fees are recomputed with the production `calculateExitFees`, not a hand-rolled formula, so the
 * repaired values are exactly what the code would have produced at the time.
 *
 *   paper_trades               fees += exit total, realized_pnl -= exit total, fee_breakdown.exit
 *   paper_trade_partial_exits  exit_fees = exit total, realized_pnl -= exit total
 *   paper_trade_events         details exitFees / totalFees / realizedPnl corrected
 *
 * Every touched row keeps its original values under a `correction` key, so the repair is
 * reversible from the row itself and the original reading is not destroyed. The event details are
 * corrected rather than left contradicting the trade: `event_type` is a closed enum with no
 * correction member, so a separate event is not available without a schema change.
 *
 * Dry run by default. Pass `--apply` to write.
 */

interface Candidate {
  id: string;
  exitPrice: number;
  quantity: number;
  fees: number;
  realizedPnl: number;
  partialExits: number;
}

const CORRECTION_REASON = "exit fees were suppressed by an explicit 0 from paper:trades:evaluate";
const BARE_ZERO_EXIT = JSON.stringify({ total: 0 });

async function main(): Promise<void> {
  const apply = process.argv.slice(2).includes("--apply");
  const environment = loadEnvironment();
  const database = createDatabasePool(environment.DATABASE_URL);
  try {
    const { rows } = await database.query<Record<string, unknown>>(`
      SELECT pt.id, pt.exit_price, pt.quantity, pt.fees, pt.realized_pnl,
             (SELECT count(*) FROM paper_trade_partial_exits pe WHERE pe.paper_trade_id = pt.id) AS partial_exits
      FROM paper_trades pt
      WHERE pt.fee_breakdown->'exit' = $1::jsonb
        AND pt.status = 'CLOSED'
        AND pt.exit_price > 0
        AND pt.exit_reason <> 'EXPIRED'
      ORDER BY pt.closed_at
    `, [BARE_ZERO_EXIT]);

    const candidates: Candidate[] = rows.map((row) => ({
      id: String(row.id),
      exitPrice: Number(row.exit_price),
      quantity: Number(row.quantity),
      fees: Number(row.fees),
      realizedPnl: Number(row.realized_pnl),
      partialExits: Number(row.partial_exits),
    }));

    const skipped: { id: string; reason: string }[] = [];
    const repairs: { candidate: Candidate; breakdown: ReturnType<typeof calculateExitFees> }[] = [];
    for (const candidate of candidates) {
      if (!Number.isInteger(candidate.quantity) || candidate.quantity <= 0) {
        skipped.push({ id: candidate.id, reason: `non-integer quantity ${candidate.quantity}` });
        continue;
      }
      // One slice per trade is the shape every row in this table has. A trade that was scaled out
      // would need the fee apportioned across slices, which is a different repair -- refuse rather
      // than guess which slice should carry it.
      if (candidate.partialExits !== 1) {
        skipped.push({ id: candidate.id, reason: `${candidate.partialExits} partial-exit rows, expected 1` });
        continue;
      }
      repairs.push({ candidate, breakdown: calculateExitFees(candidate.exitPrice, candidate.quantity) });
    }

    const totalUncharged = repairs.reduce((sum, entry) => sum + entry.breakdown.total, 0);
    const pnlBefore = repairs.reduce((sum, entry) => sum + entry.candidate.realizedPnl, 0);

    console.info(JSON.stringify({
      level: "info",
      message: apply ? "Repairing zeroed exit fees" : "Zeroed exit fees (dry run; pass --apply to write)",
      matched: candidates.length,
      repairable: repairs.length,
      skipped,
      totalUnchargedFees: Number(totalUncharged.toFixed(2)),
      averageFee: repairs.length ? Number((totalUncharged / repairs.length).toFixed(2)) : 0,
      realizedPnlBefore: Number(pnlBefore.toFixed(2)),
      realizedPnlAfter: Number((pnlBefore - totalUncharged).toFixed(2)),
    }, null, 2));

    if (!apply) return;

    const client = await database.connect();
    try {
      await client.query("BEGIN");
      for (const { candidate, breakdown } of repairs) {
        const fee = breakdown.total;
        await client.query(`
          UPDATE paper_trades
          SET fees = fees + $2,
              realized_pnl = realized_pnl - $2,
              fee_breakdown = jsonb_set(
                jsonb_set(fee_breakdown, '{exit}', $3::jsonb, true),
                '{correction}',
                jsonb_build_object(
                  'reason', $4::text,
                  'appliedAt', now(),
                  'previous', jsonb_build_object(
                    'fees', fees, 'realizedPnl', realized_pnl, 'exit', fee_breakdown->'exit'
                  )
                ),
                true
              )
          WHERE id = $1 AND fee_breakdown->'exit' = $5::jsonb
        `, [candidate.id, fee, JSON.stringify(breakdown), CORRECTION_REASON, BARE_ZERO_EXIT]);

        await client.query(`
          UPDATE paper_trade_partial_exits
          SET exit_fees = $2, realized_pnl = realized_pnl - $2
          WHERE paper_trade_id = $1 AND exit_fees = 0
        `, [candidate.id, fee]);

        await client.query(`
          UPDATE paper_trade_events
          SET details = details
            || jsonb_build_object(
                 'exitFees', $2::numeric,
                 'totalFees', (details->>'totalFees')::numeric + $2::numeric,
                 'realizedPnl', (details->>'realizedPnl')::numeric - $2::numeric
               )
            || jsonb_build_object('correction', jsonb_build_object(
                 'reason', $3::text,
                 'appliedAt', now(),
                 'previous', jsonb_build_object(
                   'exitFees', details->'exitFees',
                   'totalFees', details->'totalFees',
                   'realizedPnl', details->'realizedPnl'
                 )
               ))
          WHERE paper_trade_id = $1 AND details ? 'exitFees' AND (details->>'exitFees')::numeric = 0
        `, [candidate.id, fee, CORRECTION_REASON]);
      }
      await client.query("COMMIT");
      console.info(JSON.stringify({ level: "info", message: "Repair committed", trades: repairs.length }));
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await database.end();
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
