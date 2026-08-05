import type { Migration } from "../migration-runner.js";

// Removes the paper trades and trade ideas created to verify the option entry/exit paths.
//
// Four ideas were inserted during 2026-08-05 to exercise chain-mid marking, the chain-priced
// entry fill, and both branches of the volume gate. Each was needed because the market was
// closed and the real generator persists nothing without a new candle. Each produced one
// paper trade, and all four trades were flagged `excluded_from_evidence` so no aggregate ever
// counted them.
//
// Exclusion was enough to keep the metrics honest but it is not enough to leave behind:
// `paper_trades` is small, and four of seven rows being test scaffolding makes every future
// query over it something a reader has to filter by hand. They also inflate the trade count in
// any UI that reports one.
//
// The two trades booked on the phantom BANKNIFTY 2026-08-04 expiry are deliberately NOT
// removed. Those are a record of a real defect -- premiums priced against a contract that
// never traded -- and deleting them would erase the evidence rather than the noise. They stay
// excluded and visible.
//
// Deletion order follows the foreign keys: reviews and events reference the trade, the trade
// references the idea. Each step is scoped to the synthetic marker AND to
// `excluded_from_evidence`, so a real trade cannot be caught by a mis-set flag alone.
export const purgeSyntheticVerificationRowsMigration: Migration = {
  id: "042-purge-synthetic-verification-rows",
  sql: `
    CREATE TEMP TABLE synthetic_verification_trades AS
    SELECT pt.id AS trade_id, ti.id AS idea_id
    FROM paper_trades pt
    INNER JOIN trade_ideas ti ON ti.id = pt.trade_idea_id
    WHERE ti.evidence ->> 'synthetic' = 'true'
      AND pt.excluded_from_evidence = TRUE;

    DELETE FROM trade_reviews
    WHERE trade_id IN (SELECT trade_id FROM synthetic_verification_trades);

    DELETE FROM paper_trade_events
    WHERE paper_trade_id IN (SELECT trade_id FROM synthetic_verification_trades);

    DELETE FROM paper_trades
    WHERE id IN (SELECT trade_id FROM synthetic_verification_trades);

    -- Now unreferenced, so the ideas can go too. Scoped to ideas whose trade was just
    -- removed, plus any synthetic idea that never produced one.
    DELETE FROM trade_ideas
    WHERE evidence ->> 'synthetic' = 'true'
      AND NOT EXISTS (SELECT 1 FROM paper_trades WHERE paper_trades.trade_idea_id = trade_ideas.id);

    DROP TABLE synthetic_verification_trades;
  `,
};
