import type { Migration } from "../migration-runner.js";

/**
 * Keeps a traded-volume figure the feed reported but that cannot be a real cumulative count.
 *
 * On 2026-08-18 `vol_traded_today` for an expiry-day ATM NIFTY option arrived negative, the existing
 * `CHECK (volume IS NULL OR volume >= 0)` correctly rejected it, and the unhandled rejection killed
 * the scheduler 25 times over. The check is right and stays; what was missing was somewhere to put an
 * observation we do not believe.
 *
 * Deliberately unconstrained. This column is the one place in the schema allowed to hold a value that
 * failed validation, because its whole purpose is to record what the provider said. Adding
 * `volume_raw >= 0` here would reintroduce the crash in the column built to prevent it.
 *
 * The evidence says a signed 32-bit counter overflowed: the largest volume stored that day was
 * 2,147,470,650, i.e. 12,997 below the int32 maximum, and adding 2^32 to the rejected values lands on
 * 2.30e9-2.44e9. That makes `volume = volume_raw + 2^32` a plausible backfill -- but only once the
 * provider's field width is confirmed, which is why this migration writes no such value. A derived
 * number in a research table is indistinguishable from a measured one a month later.
 */
export const optionTickRejectedVolumeMigration: Migration = {
  id: "069-option-tick-rejected-volume",
  sql: `
    ALTER TABLE option_premium_ticks
      ADD COLUMN IF NOT EXISTS volume_raw BIGINT;

    COMMENT ON COLUMN option_premium_ticks.volume_raw IS
      'The traded volume the provider reported, kept only when it was rejected as impossible (negative, i.e. a wrapped counter, or fractional). Intentionally unconstrained: it exists to record an untrusted observation. When set, volume is NULL.';
  `,
};
