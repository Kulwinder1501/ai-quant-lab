/**
 * The point-in-time instants, and the one thing the codebase had left implicit: which instant labels
 * a bar.
 *
 * ## Why this is not a greenfield primitive
 *
 * These concepts are already implemented, twice, and the two implementations disagree in a way that
 * no type could have caught. Measured on the repository at `73e75bb`:
 *
 * | Concept | Pattern Intelligence | Scalp research harness |
 * | :--- | :--- | :--- |
 * | labels a bar by | its **open** time | its **close** time |
 * | `dataThrough` | `detectedCandle.openTime` | `decisionAt - 1ms`, where `decisionAt` is the close |
 * | `knownAt` | `max(detectedAt, dataVintageAt)` | not modelled |
 * | `earliestExecutionAt` | first bar opening strictly after `knownAt` | **not modelled at all** |
 *
 * For a 1-minute bar spanning 15:20:00 to 15:21:00, Pattern Intelligence records `dataThrough` as
 * `15:20:00.000` and the harness records it as `15:20:59.999`. Both are correct about the same bar.
 * Neither is convertible to the other without knowing which convention produced it, and the field
 * name says nothing.
 *
 * That translation currently exists in exactly one place — the harness runner passes
 * `context.candle.openTime` when reading Pattern Intelligence observations, which is right — and is
 * written down nowhere. It is one edit away from becoming a silent off-by-one-bar join, and the
 * covariate join already reconciles at 93% rather than 100%.
 *
 * So this module does not invent an interpretation. It names the two that exist, makes the conversion
 * explicit and total, and extracts the one derivation that has scar tissue on it.
 *
 * ## Deliberately not adopted by its callers yet
 *
 * Nothing here is wired into Pattern Intelligence or the harness. `dataThrough` is field 6 of the 8
 * that make a `proposalKey`, and `9,218` terminal settlements depend on those keys, so a primitive
 * that "tidies" a derivation would re-identify research history. The tests prove this module
 * reproduces both existing derivations exactly; adopting it is a separate change with its own
 * evidence, exactly as the identity relocation was.
 */

/**
 * Which end of a bar's span is used as its name.
 *
 * There is no default. A default would let a caller omit the one fact that makes an instant
 * comparable across modules, which is the whole failure this type exists to prevent.
 */
export type BarLabelConvention = "OPEN_LABELLED" | "CLOSE_LABELLED";

/** Pattern Intelligence names a bar by its open. */
export const PATTERN_INTELLIGENCE_CONVENTION: BarLabelConvention = "OPEN_LABELLED";

/** The scalp harness names a bar by its close: `decisionAt` is `candle.closeTime`. */
export const SCALP_HARNESS_CONVENTION: BarLabelConvention = "CLOSE_LABELLED";

export interface BarSpan {
  readonly openAt: Date;
  /** Exclusive: the next bar opens at this instant. */
  readonly closeAt: Date;
}

function assertValidDate(value: Date, field: string): void {
  if (Number.isNaN(value.getTime())) throw new Error(`${field} must be a valid Date.`);
}

function assertPositiveDuration(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new Error("A bar duration must be a positive, finite number of milliseconds.");
  }
}

/**
 * Resolves a bar's full span from whichever instant labels it.
 *
 * This is the conversion that makes a cross-module join exact rather than approximately right. Given
 * a label and the convention that produced it, both ends of the bar are recoverable, so an
 * open-labelled `15:20:00` and a close-labelled `15:21:00` resolve to the same span and can be
 * compared without either side knowing how the other stamps its rows.
 */
export function barSpanFromLabel(input: {
  readonly label: Date;
  readonly convention: BarLabelConvention;
  readonly durationMs: number;
}): BarSpan {
  assertValidDate(input.label, "A bar label");
  assertPositiveDuration(input.durationMs);
  const openAt = input.convention === "OPEN_LABELLED"
    ? input.label
    : new Date(input.label.getTime() - input.durationMs);
  return { openAt, closeAt: new Date(openAt.getTime() + input.durationMs) };
}

/** Re-labels a bar from one convention into the other. Total, and its own inverse. */
export function relabelBar(input: {
  readonly label: Date;
  readonly from: BarLabelConvention;
  readonly to: BarLabelConvention;
  readonly durationMs: number;
}): Date {
  const span = barSpanFromLabel({ label: input.label, convention: input.from, durationMs: input.durationMs });
  return input.to === "OPEN_LABELLED" ? span.openAt : span.closeAt;
}

/**
 * The first instant a decision on this observation could have been acted on.
 *
 * Lifted from `detect-pattern-intelligence.ts` behaviour-for-behaviour, including the reason it looks
 * like this. An earlier version added the *previous* bar's duration to the detection time, which
 * failed twice: across a session boundary the gap between consecutive bars is the overnight close, so
 * a pattern found on a session's first bar was stamped executable roughly eighteen hours late — every
 * session on a multi-day series, not an edge case — and it ignored `knownAt` entirely, so when the
 * data vintage landed after the next bar opened, that bar was already unexecutable.
 *
 * Scanning for the first bar opening **strictly** after `knownAt` answers both, because the candle
 * series is ground truth about when trading actually resumed, across weekends and holidays alike. No
 * duration arithmetic reproduces that.
 *
 * `subsequentBarOpens` must be chronological and contain only bars after the observation's own. The
 * duration fallback applies only when no such bar is in the supplied window, which means "we do not
 * yet have the bar that would answer this" — not "there is none".
 */
export function resolveEarliestExecutionAt(input: {
  readonly knownAt: Date;
  readonly subsequentBarOpens: readonly Date[];
  readonly fallbackDurationMs: number;
}): { readonly earliestExecutionAt: Date; readonly resolvedFromBar: boolean } {
  assertValidDate(input.knownAt, "knownAt");
  assertPositiveDuration(input.fallbackDurationMs);
  for (const openAt of input.subsequentBarOpens) {
    assertValidDate(openAt, "A subsequent bar open");
    if (openAt.getTime() > input.knownAt.getTime()) {
      return { earliestExecutionAt: openAt, resolvedFromBar: true };
    }
  }
  return {
    earliestExecutionAt: new Date(input.knownAt.getTime() + input.fallbackDurationMs),
    resolvedFromBar: false,
  };
}

/**
 * The five instants, sealed.
 *
 * `referenceAt` is the anchor a forward measurement counts from, and is kept separate from
 * `earliestExecutionAt` even though Pattern Intelligence currently sets them to the same instant:
 * a horizon of H bars spans the H closed bars `[0, H-1]` starting at Bar 0, and conflating "when we
 * could act" with "what we measure from" is how that becomes an off-by-one nobody can see.
 */
export interface PitInstants {
  /** When the market event occurred. */
  readonly eventAt: Date;
  /** When it became knowable to this system. */
  readonly knownAt: Date;
  /** The latest bar or tick the observation was built from, in its declared convention. */
  readonly dataThrough: Date;
  /** The convention `dataThrough` is stamped in. Required: it is not recoverable from the instant. */
  readonly dataThroughConvention: BarLabelConvention;
  /** The first instant a decision could act. */
  readonly earliestExecutionAt: Date;
  /** The anchor a forward measurement counts from. */
  readonly referenceAt: Date;
}

/**
 * Validates and freezes a set of instants.
 *
 * The ordering rules are the ones that cannot be violated without the record being wrong about
 * causality, and no others — a stricter set would reject the two live modules this is meant to
 * describe. In particular `dataThrough` is *not* constrained against `knownAt`, because the two
 * conventions place it on either side of the same bar boundary and a rule that held for one would
 * fail the other.
 */
export function sealPitInstants(instants: PitInstants): Readonly<PitInstants> {
  for (const [field, value] of [
    ["eventAt", instants.eventAt],
    ["knownAt", instants.knownAt],
    ["dataThrough", instants.dataThrough],
    ["earliestExecutionAt", instants.earliestExecutionAt],
    ["referenceAt", instants.referenceAt],
  ] as const) {
    assertValidDate(value, field);
  }
  if (instants.knownAt.getTime() < instants.eventAt.getTime()) {
    throw new Error("knownAt cannot precede eventAt: nothing is knowable before it happens.");
  }
  if (instants.earliestExecutionAt.getTime() <= instants.knownAt.getTime()) {
    throw new Error(
      "earliestExecutionAt must be strictly after knownAt, or the decision acts on information it did not have.",
    );
  }
  if (instants.referenceAt.getTime() < instants.earliestExecutionAt.getTime()) {
    throw new Error("referenceAt cannot precede earliestExecutionAt: a measurement cannot start before entry.");
  }
  // Frozen rather than merely readonly: `readonly` is erased at runtime, and these travel into
  // hashing and persistence where a later mutation would be undetectable.
  return Object.freeze({ ...instants });
}
