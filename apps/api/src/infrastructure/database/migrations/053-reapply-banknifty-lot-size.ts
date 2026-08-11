import type { Migration } from "../migration-runner.js";

/**
 * Re-applies BANKNIFTY's corrected lot size, which a re-seed had reverted.
 *
 * Migration 020 set it to 30 and explained why: 15 is the pre-revision lot, and at ~57,000 it
 * implies an 8.6 lakh contract against SEBI's 15 lakh minimum for index derivatives, so the
 * revision had been applied to NIFTY50 (75) and not to BANKNIFTY. `assessContractSize` grades 15
 * as BELOW_REGULATORY_MINIMUM.
 *
 * Why it needed re-applying. `seed-core-instruments` also carried a BANKNIFTY lot size, still at
 * 15, and the instrument upsert's `ON CONFLICT` clause assigned `lot_size = EXCLUDED.lot_size`. So
 * every `data:seed:core-instruments` run wrote the stale value back over the migration's
 * correction -- and the API container runs migrate-and-seed on every start, which made the revert
 * routine rather than occasional. Measured 2026-08-11 the live value was 15 while `strike_step`
 * from the same migration had survived at 100, which is the signature of the bug: only the column
 * the seed also set was lost.
 *
 * The same change fixes both halves so this cannot recur: the seed's constant is now 30, and the
 * upsert preserves `lot_size` on conflict instead of re-asserting it. A migration is where a
 * contract specification gets corrected; a seed is not where one gets asserted.
 *
 * Idempotent and narrow: it only moves a lot size that is still at the pre-revision value, so
 * re-running it cannot disturb a later, properly sourced revision.
 */
export const reapplyBankniftyLotSizeMigration: Migration = {
  id: "053-reapply-banknifty-lot-size",
  sql: `
    UPDATE instruments
       SET lot_size = 30
     WHERE symbol = 'BANKNIFTY'
       AND lot_size = 15;
  `,
};
