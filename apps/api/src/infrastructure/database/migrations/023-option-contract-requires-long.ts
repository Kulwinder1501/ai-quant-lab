import type { Migration } from "../migration-runner.js";

// An option-buyer position is long premium, so the database now says so.
//
// The dynamic evaluation path only models a bought option: `decideOptionBuyerExit` and
// `decideOptionBuyerLiveExit` both throw for any other side, because a short premium
// position has inverted barriers and unbounded risk that none of the sizing, fee, or
// exit logic accounts for. Throwing is right — silently evaluating a short with a
// buyer's rules would produce fictional P&L.
//
// But nothing stopped such a row existing. Migration 022's contract constraint checked
// only that the four option fields agreed with each other, so a SHORT row carrying
// option columns was insertable, and the throw it triggered aborted evaluation for every
// remaining trade on the account: stops and targets would quietly stop firing, and the
// symptom would read as "the evaluator is broken" rather than "one row is invalid".
//
// The row is now impossible, which is the better half of the fix. The evaluator also
// isolates per-trade failures so no single trade can take down a batch.
//
// Verified before adding: zero existing rows carry option columns, so nothing is
// grandfathered in.
export const optionContractRequiresLongMigration: Migration = {
  id: "023-option-contract-requires-long",
  sql: `
    ALTER TABLE paper_trades DROP CONSTRAINT IF EXISTS paper_trades_option_contract_check;
    ALTER TABLE paper_trades
      ADD CONSTRAINT paper_trades_option_contract_check
      CHECK (
        (
          option_strike IS NULL
          AND option_expiry IS NULL
          AND option_type IS NULL
          AND underlying_symbol IS NULL
        )
        OR (
          option_strike IS NOT NULL
          AND option_strike > 0
          AND option_expiry IS NOT NULL
          AND option_type IS NOT NULL
          AND underlying_symbol IS NOT NULL
          -- An option buyer is long premium whichever way the underlying view points.
          AND side = 'LONG'
        )
      );
  `,
};
