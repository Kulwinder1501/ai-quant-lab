import type { DatabaseQueryable } from "../database.js";
import type { AtmPremiumContract } from "../../../modules/market-data/domain/atm-premium-contracts.js";

interface OpenContractRow {
  underlying_symbol: string;
  expiry_date: Date | string;
  strike_price: string | number;
  option_type: string;
  provider_symbol: string | null;
}

function toExpiryDate(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Database returned an invalid option expiry date.");
  }
  return parsed.toISOString().slice(0, 10);
}

/**
 * The contracts an open position needs quoted, whatever the ATM band is doing.
 *
 * `OptionPremiumTickStreamer` subscribes to a strike band computed from the newest chain
 * snapshot. That band tracks spot, and a position does not: on a trending day the underlying
 * walks away from the strike that was ATM at entry, the band stops covering it, and the tick
 * series for the one contract whose stop still has to resolve goes quiet. The exit then falls
 * back to a stale bid or to the model mark, which is how a barrier gets crossed unnoticed
 * between runs.
 *
 * The provider symbol comes from `option_chain_snapshots` rather than being assembled from
 * strike and expiry. Fyers option symbols are not derivable from the contract's economics --
 * weekly and monthly tenors spell out differently, and BANKNIFTY has no weekly at all -- so a
 * constructed symbol subscribes to nothing and fails silently. The newest snapshot that ever
 * carried the contract is used, not the newest snapshot overall: a drifted strike is precisely
 * the one missing from the current one, and a symbol does not change once assigned.
 */
export class PostgresOpenPositionContractRepository {
  constructor(private readonly database: DatabaseQueryable) {}

  async listForUnderlying(underlyingSymbol: string): Promise<AtmPremiumContract[]> {
    const result = await this.database.query<OpenContractRow>(
      `SELECT DISTINCT ON (trade.option_strike, trade.option_type, trade.option_expiry)
              trade.underlying_symbol,
              trade.option_expiry AS expiry_date,
              trade.option_strike AS strike_price,
              trade.option_type,
              contract.provider_symbol
         FROM paper_trades trade
         LEFT JOIN LATERAL (
           SELECT snapshot.provider_symbol
             FROM option_chain_snapshots snapshot
            WHERE UPPER(snapshot.underlying_symbol) = UPPER(trade.underlying_symbol)
              AND snapshot.expiry_date = trade.option_expiry::date
              AND snapshot.strike_price = trade.option_strike
              AND snapshot.option_type = trade.option_type
            ORDER BY snapshot.observed_at DESC
            LIMIT 1
         ) contract ON TRUE
        WHERE trade.status = 'OPEN'
          AND trade.option_type IS NOT NULL
          AND trade.option_strike IS NOT NULL
          AND trade.option_expiry IS NOT NULL
          AND UPPER(trade.underlying_symbol) = UPPER($1)`,
      [underlyingSymbol],
    );

    const contracts: AtmPremiumContract[] = [];
    for (const row of result.rows) {
      if (row.provider_symbol === null) {
        /*
         * A LEFT JOIN, so this is loud rather than absent. An inner join would drop exactly the
         * position this class exists to protect -- one whose contract no snapshot ever carried --
         * and it would drop it silently, leaving the band-only subscription that was already the
         * problem. There is nothing to subscribe to without a provider symbol, so the position
         * still goes unquoted; the difference is that someone can see it.
         */
        console.warn(JSON.stringify({
          level: "warn",
          message: "An open option position has no chain snapshot, so it cannot be quoted by symbol",
          underlyingSymbol: row.underlying_symbol,
          strikePrice: Number(row.strike_price),
          optionType: row.option_type,
        }));
        continue;
      }
      contracts.push({
        underlyingSymbol: row.underlying_symbol,
        expiryDate: toExpiryDate(row.expiry_date),
        strikePrice: Number(row.strike_price),
        optionType: row.option_type === "PE" ? "PE" : "CE",
        providerSymbol: row.provider_symbol,
      });
    }
    return contracts;
  }
}
