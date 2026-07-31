import type { Migration } from "../migration-runner.js";

// Corrects the BANKNIFTY lot size and moves the strike interval into instrument data.
//
// **Lot size.** Migration 019 set NIFTY50 to 75 and BANKNIFTY to 15, describing both as
// "official NSE figures as of Jul 2025". 75 is the post-revision NIFTY figure, but 15 is
// BANKNIFTY's *pre-revision* lot: at ~57,000 it implies an ₹8.6 lakh contract against
// SEBI's ₹15 lakh minimum, so the revision was applied to one index and not the other.
// 30 puts the contract at ~₹17.2 lakh, inside the band exchanges size lots to.
//
// This value should still be confirmed against the current NSE contract note before it
// is trusted for anything but paper trading -- lot sizes are revised as indices drift,
// and `assessContractSize` now flags any configured lot whose implied notional leaves
// the expected band, so a future stale value surfaces instead of sitting silently.
//
// **Strike interval.** `mapIdeaToOptionBuyerFill` chose it with
// `underlyingEntry >= 20000 ? 50 : 100`. Both indices are above 20,000, so BANKNIFTY got
// a 50-point step and produced strikes that do not exist on the exchange (57,150).
// A price threshold cannot separate two indices that trade in the same range, so the
// interval becomes instrument metadata like every other contract specification 019
// introduced.
export const correctFnoContractSpecsMigration: Migration = {
  id: "020-correct-fno-contract-specs",
  sql: `
    ALTER TABLE instruments ADD COLUMN IF NOT EXISTS strike_step NUMERIC(20, 2);
    ALTER TABLE instruments DROP CONSTRAINT IF EXISTS instruments_strike_step_check;
    ALTER TABLE instruments
      ADD CONSTRAINT instruments_strike_step_check
      CHECK (strike_step IS NULL OR strike_step > 0);

    UPDATE instruments SET lot_size = 30, strike_step = 100 WHERE symbol = 'BANKNIFTY';
    UPDATE instruments SET strike_step = 50 WHERE symbol = 'NIFTY50';
  `,
};
