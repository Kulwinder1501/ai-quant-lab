/**
 * A log-only observation: did this account already open the opposite-direction option on the same
 * underlying in the last 15 minutes?
 *
 * ## Why it exists, and why it only observes
 *
 * On 2026-10-13 AutoBot-Sniper bought a NIFTY PE at 10:45 and a NIFTY CE at 10:50, and lost on
 * both. Tested over all 136 closed Sniper trades, entries that reversed a trade opened in the prior
 * 15 minutes lost -546 on average (n=8) against -57 for the rest. That is p=0.051 raw and 0.10 after
 * Holm, and two of the eight were the trades that suggested the hypothesis -- without them n=6 and
 * p=0.23. A rule that cannot be told apart from noise must not decide whether the bot trades, so
 * this stamps the trade and nothing else.
 *
 * The stamp is in `paper_trades.notes` (`OBSERVED_OPPOSITE_SIGNAL_15M`), so it needs no migration
 * and the trade is joined to its outcome for free. Review it with
 * `notes LIKE '%OBSERVED_OPPOSITE_SIGNAL_15M%'` once ~30 flagged trades exist, using the same
 * permutation test, and decide then.
 *
 * ## What this must never do
 *
 * Block, resize or delay an entry. A failed lookup returns null and the trade opens unstamped, the
 * same contract as `recordRegimeObservation` in the bot CLI -- a research read must not be able to
 * decide whether the bot trades. "Unstamped" therefore means *unknown*, not *no opposite signal*.
 */
export const OPPOSITE_SIGNAL_WINDOW_MINUTES = 15;
export const OPPOSITE_SIGNAL_OBSERVATION_CODE = "OBSERVED_OPPOSITE_SIGNAL_15M";

export interface ObservationDatabase {
  query(text: string, values: unknown[]): Promise<{ rows: Array<{ opposite_count: string | number }> }>;
}

export interface OppositeSignalObservationInput {
  database: ObservationDatabase;
  accountId: string;
  underlyingSymbol: string;
  /** The contract about to be bought: CE is a bullish view, PE a bearish one. */
  optionType: "CE" | "PE";
  now: Date;
}

/**
 * Returns the note fragment to append to the trade's notes, or null when there is nothing to
 * record (no opposite entry in the window, or the lookup failed).
 */
export async function observeOppositeSignal(input: OppositeSignalObservationInput): Promise<string | null> {
  try {
    const since = new Date(input.now.getTime() - OPPOSITE_SIGNAL_WINDOW_MINUTES * 60_000);
    const result = await input.database.query(
      `SELECT COUNT(*) AS opposite_count
         FROM paper_trades
        WHERE account_id = $1
          AND underlying_symbol = $2
          AND option_type IS NOT NULL
          AND option_type <> $3
          AND opened_at >= $4
          AND opened_at <= $5`,
      [input.accountId, input.underlyingSymbol, input.optionType, since, input.now],
    );
    const count = Number(result.rows[0]?.opposite_count ?? 0);
    return count > 0
      ? ` Observed (log-only, no effect on entry): ${OPPOSITE_SIGNAL_OBSERVATION_CODE}.`
      : null;
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Opposite-signal observation failed; the trade opens unstamped.",
      accountId: input.accountId,
      underlyingSymbol: input.underlyingSymbol,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}
