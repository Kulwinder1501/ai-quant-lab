import type { DatabaseQueryable } from "../database.js";
import type { RiskState, VolatilityRegime, VolatilityRegimeEvidence } from "../../../modules/risk-management/domain/risk.js";

/** The label scheme whose predictions this reads. Non-directional by construction. */
export const VOLATILITY_LABEL_SCHEME = "volatility-expansion-v1";

const VOLATILITY_REGIMES: readonly string[] = ["CONTRACTION", "STABLE", "EXPANSION"];

export class PostgresRiskStateRepository {
  constructor(private readonly client: DatabaseQueryable) {}

  /**
   * The latest volatility prediction that was already available at `asOf`.
   *
   * Read from `auxiliary_model_predictions`, never `model_predictions`: the two label
   * alphabets are disjoint by design, and a CONTRACTION/STABLE/EXPANSION value in the
   * directional table would be read downstream as a trade direction.
   *
   * The `evidence_cutoff_at <= asOf` filter is the point-in-time guard. The risk engine
   * re-checks it too, so a caller that forgets this predicate is rejected rather than
   * silently sized on a prediction from the future.
   */
  async findVolatilityRegime(input: {
    instrumentId: string;
    asOf: Date;
    maxAgeMinutes?: number;
  }): Promise<VolatilityRegimeEvidence | null> {
    const result = await this.client.query<{ prediction: string; confidence: string; evidence_cutoff_at: Date }>(`
      SELECT p.prediction, p.confidence, p.evidence_cutoff_at
      FROM auxiliary_model_predictions p
      INNER JOIN model_versions m ON m.id = p.model_version_id
      WHERE p.instrument_id = $1
        AND p.label_scheme = $2
        AND p.evidence_cutoff_at <= $3
        AND m.stage = 'PRODUCTION'
        AND ($4::integer IS NULL OR p.evidence_cutoff_at >= $3 - make_interval(mins => $4::integer))
      ORDER BY p.evidence_cutoff_at DESC, p.created_at DESC
      LIMIT 1
    `, [
      input.instrumentId,
      VOLATILITY_LABEL_SCHEME,
      input.asOf,
      input.maxAgeMinutes === undefined ? null : Math.max(1, Math.floor(input.maxAgeMinutes)),
    ]);

    const row = result.rows[0];
    if (!row) return null;
    // A value outside the alphabet means the row was written by something that does not
    // share this contract. Treated as no regime rather than coerced into one.
    if (!VOLATILITY_REGIMES.includes(row.prediction)) return null;

    return {
      prediction: row.prediction as VolatilityRegime,
      confidence: Number(row.confidence),
      evidenceCutoffAt: row.evidence_cutoff_at,
    };
  }

  /**
   * Account equity, peak equity, today's realised P&L, and open position count.
   *
   * Equity is opening balance plus realised P&L, so it is the settled figure rather
   * than a mark-to-market one. Peak equity is reconstructed by walking closed trades in
   * exit order, because no running peak is stored; that makes the drawdown check honest
   * about history it can actually see.
   */
  async findRiskState(input: {
    accountId: string;
    instrumentId: string;
    asOf: Date;
    maxRegimeAgeMinutes?: number;
  }): Promise<RiskState> {
    const account = await this.client.query<{ opening_balance: string }>(
      "SELECT opening_balance FROM paper_accounts WHERE id = $1",
      [input.accountId],
    );
    const openingBalance = Number(account.rows[0]?.opening_balance ?? 0);

    const closed = await this.client.query<{ realized_pnl: string; closed_at: Date }>(`
      SELECT COALESCE(realized_pnl, 0) AS realized_pnl, closed_at
      FROM paper_trades
      WHERE account_id = $1 AND status = 'CLOSED' AND closed_at IS NOT NULL AND closed_at <= $2
      ORDER BY closed_at ASC
    `, [input.accountId, input.asOf]);

    let equity = openingBalance;
    let peakEquity = openingBalance;
    for (const row of closed.rows) {
      equity += Number(row.realized_pnl);
      peakEquity = Math.max(peakEquity, equity);
    }

    const startOfDay = new Date(Date.UTC(
      input.asOf.getUTCFullYear(), input.asOf.getUTCMonth(), input.asOf.getUTCDate(),
    ));
    const realizedPnlToday = closed.rows
      .filter((row) => row.closed_at.getTime() >= startOfDay.getTime())
      .reduce((sum, row) => sum + Number(row.realized_pnl), 0);

    const open = await this.client.query<{ open_position_count: string }>(`
      SELECT COUNT(*) AS open_position_count
      FROM paper_trades
      WHERE account_id = $1 AND status = 'OPEN'
    `, [input.accountId]);

    return {
      accountEquity: equity,
      peakEquity,
      openPositionCount: Number(open.rows[0]?.open_position_count ?? 0),
      realizedPnlToday,
      volatilityRegime: await this.findVolatilityRegime({
        instrumentId: input.instrumentId,
        asOf: input.asOf,
        maxAgeMinutes: input.maxRegimeAgeMinutes,
      }),
    };
  }
}
