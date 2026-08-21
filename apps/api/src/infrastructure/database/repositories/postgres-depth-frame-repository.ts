import type { DatabasePool } from "../database.js";
import type { DepthFrameRow } from "../../../modules/market-data/application/capture-depth-frames.js";
import type { ClassifiedFrame } from "../../../modules/market-data/domain/depth-frame-sequencing.js";

/**
 * Writes and reads the append-only `depth_frames` event log.
 *
 * ## Batched into one statement per flush, and why that matters more here than elsewhere
 *
 * At the feed's peak a single symbol can produce a thousand frames a second. A row-per-INSERT
 * repository would spend the session in round trips and the buffer would grow faster than it
 * drains — which shows up not as slowness but as `selfDropped` frames and therefore as false gaps
 * in the very metric this table exists to produce. The batch insert is a correctness requirement
 * for the gate, not an optimisation.
 *
 * Arrays are passed straight through as Postgres arrays rather than serialised to JSON, so the
 * level-alignment CHECK in migration 070 can actually evaluate `cardinality()` on them.
 */
export class PostgresDepthFrameRepository {
  constructor(private readonly database: DatabasePool) {}

  /**
   * Appends a batch, attributed to one capture session. Returns how many rows were written.
   *
   * `captureSessionId` is not optional by design: a row that cannot be attributed cannot be excluded
   * from someone else's health report, which is how a concurrent writer corrupted a gap rate once
   * already. See migration 071.
   */
  async append(rows: readonly DepthFrameRow[], captureSessionId: string): Promise<number> {
    if (rows.length === 0) return 0;

    /** Array columns need an explicit cast, by position, or Postgres infers text[]. */
    const ARRAY_CASTS: Record<number, string> = {
      9: "::numeric[]", 10: "::bigint[]", 11: "::integer[]",
      12: "::numeric[]", 13: "::bigint[]", 14: "::integer[]",
    };
    const COLUMNS_PER_ROW = 22;

    const values: unknown[] = [];
    const tuples: string[] = [];

    rows.forEach((row, index) => {
      const base = index * COLUMNS_PER_ROW;
      tuples.push(`(${Array.from({ length: COLUMNS_PER_ROW }, (_, offset) =>
        `$${base + offset + 1}${ARRAY_CASTS[offset] ?? ""}`).join(", ")})`);
      values.push(
        row.provider,
        row.providerSymbol,
        row.sequenceNo,
        row.exchangeFeedTime,
        row.vendorSendTime,
        row.receivedAt,
        row.isSnapshot,
        row.levelsStored,
        row.levelsAvailable,
        [...row.bidPrice],
        [...row.bidQty],
        [...row.bidOrders],
        [...row.askPrice],
        [...row.askQty],
        [...row.askOrders],
        row.totalBuyQty,
        row.totalSellQty,
        row.gapBefore,
        row.isDuplicate,
        row.isRegression,
        row.payloadDigest,
        captureSessionId,
      );
    });

    const result = await this.database.query(
      `INSERT INTO depth_frames (
         provider, provider_symbol, sequence_no, exchange_feed_time, vendor_send_time,
         received_at, is_snapshot, levels_stored, levels_available,
         bid_price, bid_qty, bid_orders, ask_price, ask_qty, ask_orders,
         total_buy_qty, total_sell_qty, gap_before, is_duplicate, is_regression, payload_digest,
         capture_session_id
       ) VALUES ${tuples.join(", ")}`,
      values,
    );
    return result.rowCount ?? 0;
  }

  /**
   * The classification columns for one symbol over a window, oldest first.
   *
   * Reads back what was persisted rather than reporting in-memory state, so the gate metric
   * describes the table a researcher would actually query.
   */
  async listClassifiedFrames(input: {
    providerSymbol: string;
    captureSessionId: string;
  }): Promise<ClassifiedFrame[]> {
    const result = await this.database.query<{
      sequence_no: string | null;
      gap_before: number | null;
      is_duplicate: boolean;
      is_regression: boolean;
      is_snapshot: boolean;
    }>(
      `SELECT sequence_no, gap_before, is_duplicate, is_regression, is_snapshot
       FROM depth_frames
       WHERE provider_symbol = $1 AND capture_session_id = $2
       ORDER BY received_at ASC, sequence_no ASC`,
      [input.providerSymbol.toUpperCase(), input.captureSessionId],
    );

    return result.rows.map((row) => ({
      // BIGINT arrives as a string from node-postgres; Number is safe here because a session's
      // sequence numbers are far below 2^53.
      sequenceNo: row.sequence_no === null ? null : Number(row.sequence_no),
      gapBefore: row.gap_before,
      isDuplicate: row.is_duplicate,
      isRegression: row.is_regression,
      isSnapshot: row.is_snapshot,
    }));
  }

  /**
   * Rows for this symbol inside the window that some *other* writer produced.
   *
   * Turns contamination from an invisible corruption into a reported number. A non-zero count means
   * another collector was capturing the same contract concurrently, so anything computed over the
   * window rather than over `capture_session_id` — including any hand-written analysis query a
   * researcher runs later — is mixing two streams.
   */
  async countForeignRowsInWindow(input: {
    providerSymbol: string;
    captureSessionId: string;
    from: Date;
    to: Date;
  }): Promise<number> {
    const result = await this.database.query<{ foreign_rows: string }>(
      `SELECT COUNT(*) AS foreign_rows
       FROM depth_frames
       WHERE provider_symbol = $1
         AND received_at >= $3 AND received_at <= $4
         AND (capture_session_id IS DISTINCT FROM $2)`,
      [input.providerSymbol.toUpperCase(), input.captureSessionId, input.from, input.to],
    );
    return Number(result.rows[0]?.foreign_rows ?? 0);
  }

  /** Symbols captured in a window, with frame counts. Used to report a session at a glance. */
  async summariseSymbols(input: { from: Date; to: Date }): Promise<Array<{
    providerSymbol: string;
    frames: number;
    firstAt: Date;
    lastAt: Date;
  }>> {
    const result = await this.database.query<{
      provider_symbol: string;
      frames: string;
      first_at: Date;
      last_at: Date;
    }>(
      `SELECT provider_symbol, COUNT(*) AS frames, MIN(received_at) AS first_at,
              MAX(received_at) AS last_at
       FROM depth_frames
       WHERE received_at >= $1 AND received_at <= $2
       GROUP BY provider_symbol
       ORDER BY frames DESC`,
      [input.from, input.to],
    );

    return result.rows.map((row) => ({
      providerSymbol: row.provider_symbol,
      frames: Number(row.frames),
      firstAt: row.first_at,
      lastAt: row.last_at,
    }));
  }
}
