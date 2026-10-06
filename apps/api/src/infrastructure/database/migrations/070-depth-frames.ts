import type { Migration } from "../migration-runner.js";

/**
 * Append-only raw order-book depth events (Phase 28 step 1).
 *
 * The first table in this schema that stores a *feed event* rather than a derived observation.
 * Everything else here records what we concluded — a bar, a quote, an indicator. This records what
 * arrived, with enough provenance to prove afterwards whether it arrived intact.
 *
 * ## Append-only, and duplicates are recorded rather than refused
 *
 * There is deliberately **no unique constraint on (provider_symbol, sequence_no)**, which looks like
 * an omission and is not. A repeated sequence number is exactly the pathology this table exists to
 * measure: if the feed replays a frame, that fact is the finding, and a unique index would convert
 * it into an insert error that the collector would have to swallow or crash on. Duplicates are
 * flagged in `is_duplicate` and kept. `option_premium_ticks` takes the opposite approach for the
 * opposite reason — it stores marks that must be unique per instant, not events.
 *
 * ## Why the level arrays are truncated, and what that costs
 *
 * The feed carries 50 levels per side and can push 1000+ updates/second per active symbol. Storing
 * all 50 for a full option chain would be a materially different storage problem from anything else
 * in this database. `levels_stored` records how many were kept and `levels_available` how many the
 * frame actually carried, so a later analysis can tell truncation from a genuinely thin book — the
 * distinction that would otherwise silently corrupt any depth-weighted feature.
 *
 * The truncation is lossy and unrecoverable: levels beyond the cut are gone for good. That is an
 * accepted trade for being able to run at all, and it is the reason `levels_available` is stored
 * rather than assumed.
 *
 * ## Timestamps: three clocks, deliberately
 *
 * `exchange_feed_time` and `vendor_send_time` come from the feed and are **second-granularity** —
 * measured equal, to the second, on every frame sampled during the Phase 0 spike. They cannot
 * support any sub-second latency claim. `received_at` is our own millisecond clock stamped at the
 * socket boundary and is the only one with the resolution the research needs. Keeping all three
 * makes the limitation visible instead of letting someone infer latency from two coarse integers.
 *
 * `payload_digest` hashes the *decoded* frame, not the wire bytes: the vendor SDK decodes protobuf
 * internally and hands over an object, so the original payload is unavailable to us. It therefore
 * detects a replayed or identical frame, not a transport corruption.
 */
export const depthFramesMigration: Migration = {
  id: "070-depth-frames",
  sql: `
    CREATE TABLE IF NOT EXISTS depth_frames (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      provider TEXT NOT NULL CHECK (length(trim(provider)) > 0),
      provider_symbol TEXT NOT NULL CHECK (length(trim(provider_symbol)) > 0),

      -- Feed-supplied sequencing and clocks. Nullable because a frame that omits them is itself a
      -- finding worth storing rather than discarding.
      sequence_no BIGINT CHECK (sequence_no IS NULL OR sequence_no >= 0),
      exchange_feed_time BIGINT,
      vendor_send_time BIGINT,

      -- Our own clock, millisecond resolution, stamped at the socket boundary.
      received_at TIMESTAMPTZ NOT NULL,

      is_snapshot BOOLEAN NOT NULL,

      levels_stored SMALLINT NOT NULL CHECK (levels_stored >= 0),
      levels_available SMALLINT NOT NULL CHECK (levels_available >= 0),

      bid_price NUMERIC(20, 4)[] NOT NULL,
      bid_qty BIGINT[] NOT NULL,
      bid_orders INTEGER[] NOT NULL,
      ask_price NUMERIC(20, 4)[] NOT NULL,
      ask_qty BIGINT[] NOT NULL,
      ask_orders INTEGER[] NOT NULL,

      total_buy_qty BIGINT CHECK (total_buy_qty IS NULL OR total_buy_qty >= 0),
      total_sell_qty BIGINT CHECK (total_sell_qty IS NULL OR total_sell_qty >= 0),

      -- Derived from sequence continuity at capture time, never trusted from the feed.
      -- gap_before: how many sequence numbers were skipped immediately before this frame.
      -- NULL means there was no previous frame to compare against (first frame, or a snapshot
      -- restart), which is distinct from 0 meaning "contiguous".
      gap_before INTEGER CHECK (gap_before IS NULL OR gap_before >= 0),
      is_duplicate BOOLEAN NOT NULL DEFAULT FALSE,
      -- A sequence number lower than its predecessor: out-of-order delivery or a feed restart.
      is_regression BOOLEAN NOT NULL DEFAULT FALSE,

      payload_digest TEXT NOT NULL CHECK (length(trim(payload_digest)) > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

      -- Arrays describe the same book, so their lengths must agree. A mismatch here would make any
      -- level-wise feature silently read across misaligned sides.
      CONSTRAINT depth_frames_level_arrays_aligned CHECK (
        cardinality(bid_price) = cardinality(bid_qty)
        AND cardinality(bid_price) = cardinality(bid_orders)
        AND cardinality(ask_price) = cardinality(ask_qty)
        AND cardinality(ask_price) = cardinality(ask_orders)
        AND cardinality(bid_price) = cardinality(ask_price)
        AND cardinality(bid_price) = levels_stored
      ),
      CONSTRAINT depth_frames_truncation_is_coherent CHECK (levels_stored <= levels_available)
    );

    CREATE INDEX IF NOT EXISTS depth_frames_symbol_received_idx
    ON depth_frames (provider_symbol, received_at DESC);

    -- Deliberately not unique; see the table comment. Supports gap analysis over a session.
    CREATE INDEX IF NOT EXISTS depth_frames_symbol_sequence_idx
    ON depth_frames (provider_symbol, sequence_no);

    -- Partial index so the integrity sweep does not scan a whole session to find the anomalies.
    CREATE INDEX IF NOT EXISTS depth_frames_anomaly_idx
    ON depth_frames (provider_symbol, received_at DESC)
    WHERE is_duplicate OR is_regression OR gap_before > 0;

    COMMENT ON TABLE depth_frames IS
      'Append-only raw L2 depth events with sequencing and three clocks. Duplicates are flagged, not refused. Level arrays are truncated to levels_stored of levels_available.';
  `,
};
