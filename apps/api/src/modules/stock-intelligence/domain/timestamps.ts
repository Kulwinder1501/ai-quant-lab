import { assertPointInTime } from "../../research/domain/lookahead-guard.js";

/**
 * The three clocks every Stock Intelligence record carries.
 *
 * - `publishedAt` — when the source published it (filing date, exchange timestamp).
 * - `effectiveAt` — the economic date the fact describes (period end, ex-date).
 * - `availableAt` — the earliest instant this process could have known it. This is
 *   the PIT clock. It is never earlier than `publishedAt`.
 */
export interface PointInTimeClocks {
  readonly publishedAt: Date;
  readonly effectiveAt: Date;
  readonly availableAt: Date;
}

export function assertAvailableAtCutoff(availableAt: Date, dataCutoff: Date, label: string): void {
  assertPointInTime({ label, featureAsOf: availableAt, decidedAt: dataCutoff });
}

export function assertClocksAreOrdered(clocks: PointInTimeClocks, label: string): void {
  assertPointInTime({
    label: `${label}.publishedAt<=availableAt`,
    featureAsOf: clocks.publishedAt,
    decidedAt: clocks.availableAt,
  });
}
