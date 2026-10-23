import type { Migration } from "../migration-runner.js";

/**
 * Moves NIFTY50's lot size from 75 to the exchange's current 65.
 *
 * 75 came from migration 019 ("official NSE figures as of Jul 2025") and is the figure before the
 * exchange revised NIFTY. Three independent sources now agree on 65, measured 2026-10-23:
 *
 * - The Fyers F&O symbol master (public.fyers.in/sym_details/NSE_FO.csv): every NIFTY future and all
 *   4,067 NIFTY option contracts carry a minimum lot of 65. BANKNIFTY's 30 in the same file confirms
 *   migration 020/053 were right for that index.
 * - Stored open interest: 98.0% of 33,728 NIFTY50 chain rows over 30 days are whole multiples of 65,
 *   against 6.9% for 75 (BANKNIFTY: 100% for 30).
 * - The live data socket: last-traded quantity on NIFTY futures arrives in steps of 65.
 *
 * What depends on the column, and why this is not cosmetic: `validateQuantity` in the paper-trade
 * repository rejects any quantity that is not a multiple of it, risk evaluation sizes positions from
 * it, and scalp research stores it with each decision. Before this change a NIFTY option order had to
 * be a multiple of 75 -- a size the exchange does not trade.
 *
 * History is deliberately left alone. The 257 closed NIFTY50 paper trades were sized at 75 units a
 * lot, so their rupee P&L is overstated by about 15% against the real 65-unit contract; rewriting the
 * quantities would falsify what was simulated, so the discrepancy is documented instead.
 *
 * Narrow and idempotent, as 053 is: it only moves a lot still at the stale value, so re-running it
 * cannot overwrite a later, properly sourced revision. The seed constants are corrected in the same
 * change, because a seed that still said 75 is how BANKNIFTY's correction was reverted once already.
 */
export const correctNiftyLotSizeMigration: Migration = {
  id: "141-correct-nifty-lot-size",
  sql: `
    UPDATE instruments
       SET lot_size = 65
     WHERE symbol = 'NIFTY50'
       AND lot_size = 75;
  `,
};
