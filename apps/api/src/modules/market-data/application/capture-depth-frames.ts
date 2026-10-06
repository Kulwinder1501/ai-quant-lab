import type { DepthFrame } from "../domain/depth-frame.js";
import { classifySequence } from "../domain/depth-frame-sequencing.js";

/**
 * Buffers depth frames between flushes and stamps each with its sequence continuity.
 *
 * ## `gap_before` is measured against the last *stored* frame, not the last *received* one
 *
 * This is the one design decision here that is easy to get backwards, so it is stated plainly.
 *
 * When the buffer is full we drop frames. If continuity were tracked against everything received,
 * the row after a dropped frame would record `gapBefore: 0` and the table would claim to be
 * contiguous across a hole we created ourselves. Any book reconstructed across that hole would be
 * silently wrong — which is the exact failure mode the whole sequencing apparatus exists to prevent.
 *
 * So continuity is tracked against what was actually persisted. `gap_before` then means "sequence
 * numbers absent from this table immediately before this row", regardless of whether the feed lost
 * them or we did. That keeps the reconstruction gate honest at the cost of conflating two causes,
 * and the causes are separated by `selfDropped` in `stats()` instead: a capture with
 * `selfDropped > 0` has gaps that are our fault, and its feed-health verdict describes our
 * plumbing rather than the vendor's.
 *
 * ## The buffer refuses new frames rather than evicting old ones
 *
 * At 1000+ updates/second per symbol a stalled flush can exhaust memory in seconds. When the cap is
 * hit, arriving frames are refused and counted. Refusing the new keeps what remains a contiguous
 * run, which is worth more to a cumulative-sum feature than a longer series with a hole in the
 * middle. Either way the loss is reported and never inferred from a row count.
 */

export interface DepthFrameRow {
  readonly provider: string;
  readonly providerSymbol: string;
  readonly sequenceNo: number | null;
  readonly exchangeFeedTime: number | null;
  readonly vendorSendTime: number | null;
  readonly receivedAt: Date;
  readonly isSnapshot: boolean;
  readonly levelsStored: number;
  readonly levelsAvailable: number;
  readonly bidPrice: readonly number[];
  readonly bidQty: readonly number[];
  readonly bidOrders: readonly number[];
  readonly askPrice: readonly number[];
  readonly askQty: readonly number[];
  readonly askOrders: readonly number[];
  readonly totalBuyQty: number | null;
  readonly totalSellQty: number | null;
  readonly gapBefore: number | null;
  readonly isDuplicate: boolean;
  readonly isRegression: boolean;
  readonly payloadDigest: string;
}

export interface DepthFrameBufferStats {
  readonly accepted: number;
  readonly buffered: number;
  /** Frames refused because the buffer was full. Non-zero invalidates the feed-health verdict. */
  readonly selfDropped: number;
}

export const DEFAULT_MAX_BUFFERED_FRAMES = 20_000;

export class DepthFrameBuffer {
  private readonly rows: DepthFrameRow[] = [];
  /** Last sequence number *written to a row*, per symbol. See the header. */
  private readonly lastStoredSequence = new Map<string, number>();
  private accepted = 0;
  private selfDropped = 0;

  constructor(
    private readonly provider: string,
    private readonly maxBuffered: number = DEFAULT_MAX_BUFFERED_FRAMES,
  ) {
    if (!Number.isInteger(maxBuffered) || maxBuffered < 1) {
      throw new Error("maxBuffered must be a positive integer.");
    }
    if (provider.trim() === "") throw new Error("provider is required.");
  }

  accept(frame: DepthFrame): void {
    if (this.rows.length >= this.maxBuffered) {
      // Deliberately before classification: a refused frame must not advance continuity, or the
      // next stored row would paper over the hole we just made.
      this.selfDropped += 1;
      return;
    }

    const previous = this.lastStoredSequence.get(frame.providerSymbol) ?? null;
    const classification = classifySequence({
      sequenceNo: frame.sequenceNo,
      previousSequenceNo: previous,
      isSnapshot: frame.isSnapshot,
    });

    // A regression must not move the marker backwards: a late-arriving stale frame would otherwise
    // make every subsequent frame look like a huge forward gap.
    if (frame.sequenceNo !== null && !classification.isRegression) {
      this.lastStoredSequence.set(frame.providerSymbol, frame.sequenceNo);
    }

    this.rows.push({
      provider: this.provider,
      providerSymbol: frame.providerSymbol,
      sequenceNo: frame.sequenceNo,
      exchangeFeedTime: frame.exchangeFeedTime,
      vendorSendTime: frame.vendorSendTime,
      receivedAt: frame.receivedAt,
      isSnapshot: frame.isSnapshot,
      levelsStored: frame.levelsStored,
      levelsAvailable: frame.levelsAvailable,
      bidPrice: frame.bidPrice,
      bidQty: frame.bidQty,
      bidOrders: frame.bidOrders,
      askPrice: frame.askPrice,
      askQty: frame.askQty,
      askOrders: frame.askOrders,
      totalBuyQty: frame.totalBuyQty,
      totalSellQty: frame.totalSellQty,
      gapBefore: classification.gapBefore,
      isDuplicate: classification.isDuplicate,
      isRegression: classification.isRegression,
      payloadDigest: frame.payloadDigest,
    });
    this.accepted += 1;
  }

  /** Hands over everything buffered and empties the buffer. */
  drain(): DepthFrameRow[] {
    return this.rows.splice(0, this.rows.length);
  }

  stats(): DepthFrameBufferStats {
    return { accepted: this.accepted, buffered: this.rows.length, selfDropped: this.selfDropped };
  }
}
