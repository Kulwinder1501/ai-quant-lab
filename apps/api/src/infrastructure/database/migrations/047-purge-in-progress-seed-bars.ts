import type { Migration } from "../migration-runner.js";

// Removes candles that were never bars: Yahoo's in-progress print, stored as complete.
//
// `seed-market-data.ts` fetched real Yahoo chart data at container start and wrote every
// quote it returned. The last element of that response is the bar currently forming -- its
// date is the moment of the request rather than the grid slot, and its open, high, low and
// close are all the last traded price. Each container start therefore added one flat 60m row
// with `is_complete = true`:
//
//   2026-08-06 05:08:58.999   24635.15 / 24635.15 / 24635.15 / 24635.15   volume 0
//   2026-08-06 07:28:07.999   24659.75 / 24659.75 / 24659.75 / 24659.75   volume 0
//
// 46 of them across NIFTY50 and BANKNIFTY, 2026-08-04 to 2026-08-06, which is simply how many
// times those containers were restarted while the option-chain and pricing work was going on.
// Any 60m feature computed over those days reads them as real hours: zero range, zero volume,
// at times no session boundary falls on.
//
// Identified by grid alignment rather than by flatness. Every legitimate 60m bar opens at
// minute 45 second 0 -- 78,007 of them -- because the NSE session starts at 09:15 IST. The
// off-grid rows are exactly the artifacts, and all 46 are flat, so the two signatures agree.
// Flatness alone would not do: 19 correctly-timed 60m bars are also flat, and an hour in which
// price genuinely did not move is a real observation.
//
// The writer is fixed in the same change: a bar is only complete once its whole interval is in
// the past, so the forming bar is skipped rather than persisted.
export const purgeInProgressSeedBarsMigration: Migration = {
  id: "047-purge-in-progress-seed-bars",
  sql: `
    DELETE FROM candles
    WHERE timeframe = '60m'
      AND (
        EXTRACT(MINUTE FROM open_time)::int <> 45
        OR EXTRACT(SECOND FROM open_time)::int <> 0
      );
  `,
};
