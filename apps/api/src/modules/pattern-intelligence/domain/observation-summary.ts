import type { PatternOrientation, PatternSessionSegment, PatternTrendState } from "./contracts.js";

/**
 * A stored observation as a consumer outside this module sees it.
 *
 * Deliberately carries no score, probability, expected return or direction. `orientation` is a
 * geometric property of the structure — which way the pattern points — and is emphatically not a
 * trade side. Anything that turns it into one is making a decision Pattern Intelligence declined to
 * make, and must own that decision under its own name.
 *
 * It lives in the domain rather than beside the repository because `StrategyMarketContext` needs to
 * reference it, and a strategy contract reaching into an infrastructure module for a type would
 * invert the dependency.
 */
export interface PatternObservationSummary {
  readonly observationId: string;
  readonly patternFamily: string;
  readonly patternSubtype: string;
  readonly orientation: PatternOrientation;
  /** Kept whole so a proposal can cite the exact frozen rules that produced the observation. */
  readonly definitionId: string;
  readonly definitionVersion: string;
  readonly definitionHash: string;
  readonly detectedAt: Date;
  readonly knownAt: Date;
  readonly earliestExecutionAt: Date;
  readonly durationBars: number;
  readonly rangeBps: number;
  readonly rangeAtr: number;
  readonly trendState: PatternTrendState | string;
  readonly sessionSegment: PatternSessionSegment | string;
  readonly volumeZscore: number | null;
  readonly rangeZscore: number | null;
  readonly effortResultDivergence: number | null;
  readonly details: Record<string, unknown>;
}

/**
 * Whether the detector had actually covered the bar a consumer is reading.
 *
 * `COMPLETE` with an empty observation list means "evaluated, nothing qualified". `NOT_COVERED` means
 * "the detector has not reached this bar", and `UNKNOWN` means the consumer did not check. They are
 * three different facts and only the first licenses treating absence as information — the distinction
 * migration 079 exists to preserve, restated for this module.
 */
export type PatternObservationCoverageState = "COMPLETE" | "NOT_COVERED" | "UNKNOWN";
