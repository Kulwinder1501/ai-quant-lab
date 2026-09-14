import {
  assessTapeLiveness,
  frozenTapeIdenticalBarThreshold,
  type TapeBar,
  type TapeLivenessAssessment,
} from "../../../market-data/domain/tape-liveness.js";

/**
 * Reads the bars preceding a decision so the tape test can be applied.
 *
 * Narrowed to the one method needed rather than taking the context repository, so the domain rule
 * stays testable without a database and the two callers cannot drift into reading different columns.
 */
export interface TapeBarReader {
  findCompletedAt(input: {
    instrumentId: string;
    timeframe: string;
    closeTime: Date;
  }): Promise<{ readonly candle: TapeBar } | null>;
}

/**
 * Resolves tape liveness at a decision point.
 *
 * ## Why this is shared rather than inlined at each call site
 *
 * Two paths judge the same bar: the live capture, and `verify-live-backfill-parity`, which
 * reconstructs a closed session and compares its `ineligibleReason` against what was recorded. If
 * those two computed liveness differently -- or if reconstruction did not compute it at all and
 * assumed a live tape -- parity would report a mismatch on every bar in the frozen window, roughly 28
 * per session across the two indices. That is precisely the failure mode that made the parity check
 * unusable once before, when 483 of 748 reported mismatches turned out to be key-order artefacts: an
 * acceptance test whose false positives outnumber its findings gets read as evidence.
 *
 * So both callers resolve through here, and parity holds by construction rather than by coincidence.
 *
 * The walk stops at the first bar the reader cannot supply. A missing predecessor yields a shorter
 * window and therefore a `LIVE` verdict, which is the honest answer: absence of a comparable bar is
 * absence of evidence that the tape repeated, not evidence that it moved. Gaps are a separate defect
 * with a separate detector.
 */
export async function resolveTapeLiveness(input: {
  readonly reader: TapeBarReader;
  readonly instrumentId: string;
  readonly timeframe: string;
  readonly referenceBar: TapeBar;
  readonly referenceCloseTime: Date;
  readonly intervalMs: number;
  readonly threshold?: number;
}): Promise<TapeLivenessAssessment> {
  const threshold = input.threshold ?? frozenTapeIdenticalBarThreshold;
  const predecessors: TapeBar[] = [];

  // One fewer than the threshold: the reference bar is itself the first member of the run, so a
  // threshold of two needs exactly one predecessor. Deriving the count keeps the two in step if the
  // threshold is ever raised.
  for (let step = 1; step < threshold; step += 1) {
    const closeTime = new Date(input.referenceCloseTime.getTime() - step * input.intervalMs);
    const previous = await input.reader.findCompletedAt({
      instrumentId: input.instrumentId,
      timeframe: input.timeframe,
      closeTime,
    });
    if (!previous) break;
    predecessors.push(previous.candle);
  }

  return assessTapeLiveness({
    // `predecessors` was collected newest-first; `assessTapeLiveness` wants oldest-first with the
    // reference bar last.
    bars: [...predecessors].reverse().concat(input.referenceBar),
    intervalMs: input.intervalMs,
    ...(input.threshold === undefined ? {} : { threshold: input.threshold }),
  });
}
