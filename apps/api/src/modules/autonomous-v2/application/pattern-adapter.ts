import type { SnapshotRef } from "../../platform/snapshot/snapshot-ref.js";
import type { PitInstants } from "../../platform/pit/pit-instants.js";

/**
 * §6's `PatternAdapter`: legacy candlestick pattern → observation.
 *
 * ## It cannot produce a native `PatternObservation`, and pretending otherwise is the whole risk
 *
 * The ladder reads "legacy pattern → PatternObservation", but the two shapes are not close. A native
 * `PatternObservationSummary` carries a frozen `definitionId` / `definitionVersion` / `definitionHash`,
 * its own point-in-time instants, measured geometry (`durationBars`, `rangeBps`, `rangeAtr`), market
 * context (`trendState`, `sessionSegment`) and standardised statistics (`volumeZscore`,
 * `rangeZscore`, `effortResultDivergence`).
 *
 * A legacy candlestick detection carries a code, an `algorithmVersion`, a direction, a detector
 * confidence and some untyped details. That is all.
 *
 * So an adapter that returned `PatternObservationSummary` would have to invent a definition hash,
 * three geometry measurements, two context labels and three z-scores. Those are not defaults, they
 * are claims — `rangeAtr: 0` asserts a pattern with no range, and `volumeZscore: 0` asserts perfectly
 * average volume. Every one of them would then be indistinguishable from a measured value, in a
 * system whose research conclusions are drawn from exactly these fields.
 *
 * This adapter therefore produces a **`LegacyPatternObservation`**: a distinct type holding only what
 * the legacy detector actually knew, marked with its provenance. TypeScript's structural typing does
 * the enforcement for free — it lacks the native fields, so it cannot be passed where a native
 * observation is expected, and the `provenance` discriminator makes any deliberate union explicit.
 *
 * ## The instants come from the sealed snapshot, never from here
 *
 * A legacy pattern has no instants at all. It is a row attached to a bar, so the only defensible
 * answer to "when was this knowable" is the bar's own sealed PIT instants — which is why this adapter
 * takes a `MarketSnapshot`'s output rather than a bare pattern, and why `MarketContextAdapter` had to
 * exist first. Deriving instants here would be reconstructing a timeline from a row that never had
 * one.
 *
 * ## Two things deliberately not carried
 *
 * **Ranking.** "Legacy candlestick ranking" is on §6's QUARANTINE list, and `patterns[0]` with it.
 * The output is a list in input order with no rank field and no documented ordering; a consumer that
 * wants a winner must choose one in its own code.
 *
 * **A composite.** No aggregate of the detector confidences is produced, for the same reason
 * `MarketSnapshot` has no score field: composite confidence is quarantined, and a single number
 * summarising several patterns is where V1's scorer would take up residence inside V2.2.
 *
 * ## The vocabularies are not isomorphic, and that biases grouping
 *
 * Legacy direction is `BULLISH | BEARISH | NEUTRAL`; native orientation is
 * `UP | DOWN | NONE | BIDIRECTIONAL`. So **no legacy-derived observation can ever be
 * `BIDIRECTIONAL`** — the source vocabulary cannot express it. Any analysis grouping by orientation
 * will find legacy rows structurally absent from that bucket, which is an artifact of the mapping
 * rather than a fact about markets. Recorded because a zero in that cell would otherwise read as
 * evidence.
 */

export type LegacyPatternDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type ObservationOrientation = "UP" | "DOWN" | "NONE" | "BIDIRECTIONAL";

export interface LegacyCandlestickPattern {
  readonly code: string;
  readonly algorithmVersion: string;
  readonly direction: LegacyPatternDirection;
  /** The detector's own confidence. Carried per pattern; never composed. */
  readonly confidence: number;
  readonly contextCandleIds: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
}

export interface LegacyPatternObservation {
  /**
   * Marks this as legacy-derived, permanently.
   *
   * Not a nicety: a native observation and this one are answerable to different questions, and a
   * study that pooled them would be mixing a measured definition hash with an `algorithmVersion`
   * string. The discriminator is what makes a deliberate union safe and an accidental one visible.
   */
  readonly provenance: "LEGACY_CANDLESTICK";
  readonly patternCode: string;
  readonly algorithmVersion: string;
  readonly orientation: ObservationOrientation;
  readonly detectorConfidence: number;
  readonly contextCandleIds: readonly string[];
  readonly details: Readonly<Record<string, unknown>>;
  /** The bar's sealed instants. A legacy pattern has none of its own. */
  readonly instants: Readonly<PitInstants>;
  /** The market state it was observed in, so the pair can be replayed. */
  readonly observedIn: SnapshotRef;
}

export class PatternAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatternAdapterError";
  }
}

/**
 * Total by construction: an unrecognised direction throws rather than defaulting.
 *
 * Defaulting to `NONE` would relabel a directional pattern as neutral, which is the quietest
 * possible way to destroy a signal — the row survives, the analysis runs, and the bias is invisible.
 */
export function orientationFromLegacyDirection(direction: string): ObservationOrientation {
  switch (direction) {
    case "BULLISH": return "UP";
    case "BEARISH": return "DOWN";
    case "NEUTRAL": return "NONE";
    default:
      throw new PatternAdapterError(
        `Unmapped legacy pattern direction "${direction}". Refused rather than defaulted: mapping an `
        + "unknown direction to NONE would relabel a directional pattern as neutral, and nothing "
        + "downstream could tell that had happened.",
      );
  }
}

/**
 * Translates the legacy patterns carried on one sealed bar.
 *
 * Order is preserved only so the output can be compared to the input during differential testing. It
 * carries no meaning and no rank; see the note above on quarantined ranking.
 */
export function legacyPatternObservations(input: {
  readonly patterns: readonly LegacyCandlestickPattern[];
  readonly instants: Readonly<PitInstants>;
  readonly observedIn: SnapshotRef;
  /**
   * Whether the pattern layer was computed for this bar.
   *
   * Required, and refused when false with patterns present, for the reason `MarketContextAdapter`
   * refuses the same contradiction: coverage is declared, never inferred from emptiness, and rows
   * under a not-computed layer have unknown provenance.
   */
  readonly patternsComputed: boolean;
}): readonly LegacyPatternObservation[] {
  if (!input.patternsComputed && input.patterns.length > 0) {
    throw new PatternAdapterError(
      `${input.patterns.length} pattern(s) supplied but the layer is declared not computed. Coverage `
      + "is declared, never inferred, so this contradiction is refused rather than resolved.",
    );
  }
  if (!input.patternsComputed) return Object.freeze([]);

  return Object.freeze(input.patterns.map((pattern) => {
    if (!Number.isFinite(pattern.confidence)) {
      throw new PatternAdapterError(
        `${pattern.code}: detector confidence must be a finite number, not ${pattern.confidence}.`,
      );
    }
    return Object.freeze({
      provenance: "LEGACY_CANDLESTICK" as const,
      patternCode: pattern.code,
      algorithmVersion: pattern.algorithmVersion,
      orientation: orientationFromLegacyDirection(pattern.direction),
      detectorConfidence: pattern.confidence,
      contextCandleIds: Object.freeze([...pattern.contextCandleIds]),
      details: Object.freeze({ ...pattern.details }),
      instants: input.instants,
      observedIn: input.observedIn,
    });
  }));
}
