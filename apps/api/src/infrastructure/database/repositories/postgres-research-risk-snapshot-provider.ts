import type { DatabaseQueryable } from "../database.js";
import type { ResearchRiskSnapshotState } from "../../../modules/research/scalp-harness/domain/contracts.js";
import { PostgresRiskStateRepository } from "./postgres-risk-state-repository.js";

function istDayStart(value: Date): Date {
  const date = new Date(value.getTime() + 330 * 60_000).toISOString().slice(0, 10);
  return new Date(`${date}T00:00:00+05:30`);
}

/** Read-only, point-in-time reconstruction. It never mutates account, trade, or risk state. */
export class PostgresResearchRiskSnapshotProvider {
  constructor(private readonly database: DatabaseQueryable) {}

  async capture(input: {
    accountId: string;
    instrumentIds: readonly string[];
    asOf: Date;
  }): Promise<ResearchRiskSnapshotState> {
    const account = await this.database.query<{ opening_balance: string }>(
      "SELECT opening_balance FROM paper_accounts WHERE id = $1",
      [input.accountId],
    );
    const openingBalance = Number(account.rows[0]?.opening_balance);
    if (!Number.isFinite(openingBalance) || openingBalance < 0) throw new Error(`Unknown paper account ${input.accountId}.`);

    const closed = await this.database.query<{ realized_pnl: string; closed_at: Date }>(`
      SELECT COALESCE(realized_pnl, 0) AS realized_pnl, closed_at
      FROM paper_trades
      WHERE account_id = $1 AND closed_at IS NOT NULL AND closed_at <= $2
      ORDER BY closed_at ASC, id ASC
    `, [input.accountId, input.asOf]);
    let accountEquity = openingBalance;
    let peakEquity = openingBalance;
    for (const row of closed.rows) {
      accountEquity += Number(row.realized_pnl);
      peakEquity = Math.max(peakEquity, accountEquity);
    }
    const start = istDayStart(input.asOf).getTime();
    const realizedPnlToday = closed.rows
      .filter((row) => row.closed_at.getTime() >= start)
      .reduce((sum, row) => sum + Number(row.realized_pnl), 0);

    const open = await this.database.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM paper_trades trade
      WHERE trade.account_id = $1
        AND trade.opened_at <= $2
        AND (trade.closed_at IS NULL OR trade.closed_at > $2)
        AND NOT EXISTS (
          SELECT 1 FROM paper_trade_events event
          WHERE event.paper_trade_id = trade.id
            AND event.event_type = 'CANCELLED'
            AND event.occurred_at <= $2
        )
    `, [input.accountId, input.asOf]);

    const volatilityRepository = new PostgresRiskStateRepository(this.database);
    const volatilityEvidenceByInstrument: Record<string, Awaited<ReturnType<PostgresRiskStateRepository["findVolatilityRegime"]>>> = {};
    for (const instrumentId of [...new Set(input.instrumentIds)].sort()) {
      volatilityEvidenceByInstrument[instrumentId] = await volatilityRepository.findVolatilityRegime({
        instrumentId,
        asOf: input.asOf,
        maxAgeMinutes: 60,
      });
    }
    return {
      accountEquity,
      peakEquity,
      openPositionCount: Number(open.rows[0]?.count ?? 0),
      realizedPnlToday,
      volatilityEvidenceByInstrument,
    };
  }
}
