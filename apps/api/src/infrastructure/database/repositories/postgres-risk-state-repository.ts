import type { DatabaseQueryable } from "../database.js";
import type {
  BreadthEvidence,
  RiskState,
  VolatilityRegime,
  VolatilityRegimeEvidence,
} from "../../../modules/risk-management/domain/risk.js";

/** The label scheme whose predictions this reads. Non-directional by construction. */
export const VOLATILITY_LABEL_SCHEME = "volatility-expansion-v1";

const VOLATILITY_REGIMES: readonly string[] = ["CONTRACTION", "STABLE", "EXPANSION"];

/** Breadth is NIFTYNXT50 (the market outside the top 50) measured against NIFTY50 itself. */
const BREADTH_SYMBOL = "NIFTYNXT50";
const BREADTH_INDEX_SYMBOL = "NIFTY50";

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
   * NIFTYNXT50's daily return minus NIFTY50's, for the most recently completed session
   * strictly before `asOf`. See `BreadthEvidence` in risk.ts for what this measures and why.
   *
   * Each symbol's own two most recent daily closes before `asOf` are read independently and
   * matched by calendar date rather than joined in SQL, because the two series are not
   * guaranteed to update in the same transaction -- a same-date match is the point-in-time
   * guarantee this needs, not a row-count coincidence.
   */
  async findBreadthEvidence(asOf: Date): Promise<BreadthEvidence | null> {
    const closesFor = async (symbol: string): Promise<Array<{ date: string; close: number }>> => {
      const result = await this.client.query<{ close_time: Date; close: string }>(`
        SELECT close_time, close FROM candles
        WHERE instrument_id = (SELECT id FROM instruments WHERE symbol = $1)
          AND timeframe = '1d' AND close_time < $2
        ORDER BY close_time DESC
        LIMIT 3
      `, [symbol, asOf]);
      return result.rows.map((row) => ({
        date: row.close_time.toISOString().slice(0, 10),
        close: Number(row.close),
      }));
    };

    const [nxt50Closes, niftyCloses] = await Promise.all([
      closesFor(BREADTH_SYMBOL),
      closesFor(BREADTH_INDEX_SYMBOL),
    ]);

    const niftyByDate = new Map(niftyCloses.map((row) => [row.date, row.close]));
    const nxt50Dates = nxt50Closes.map((row) => row.date).filter((date) => niftyByDate.has(date));
    if (nxt50Dates.length < 2) return null;

    const [currentDate, previousDate] = nxt50Dates;
    const nxt50ByDate = new Map(nxt50Closes.map((row) => [row.date, row.close]));
    const nxt50Current = nxt50ByDate.get(currentDate)!;
    const nxt50Previous = nxt50ByDate.get(previousDate)!;
    const niftyCurrent = niftyByDate.get(currentDate)!;
    const niftyPrevious = niftyByDate.get(previousDate)!;
    if (nxt50Previous === 0 || niftyPrevious === 0) return null;

    const nxt50Return = (nxt50Current - nxt50Previous) / nxt50Previous;
    const niftyReturn = (niftyCurrent - niftyPrevious) / niftyPrevious;

    return {
      relativeReturn: nxt50Return - niftyReturn,
      evidenceCutoffAt: new Date(`${currentDate}T00:00:00.000Z`),
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
      breadthEvidence: await this.findBreadthEvidence(input.asOf),
    };
  }
}
