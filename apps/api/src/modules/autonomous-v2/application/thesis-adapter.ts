/**
 * §6's `ThesisAdapter` — *"differential analysis only, not live decisions"*.
 *
 * ## The constraint is structural, not a comment
 *
 * The ladder permits this adapter for comparison and forbids it from driving live decisions. A
 * docblock saying so would be worth very little: the next person with a deadline finds a legacy
 * thesis object sitting in `autonomous-v2` and wires it in, and the guard was only ever a sentence.
 *
 * So this adapter does not produce a thesis. It produces the two **strings** P13 compares — a
 * comparison key and a canonical outcome label. There is no side field, no price, no quantity and no
 * contract on the way out, so there is nothing to execute. `legacyThesisComparison` is unusable for
 * trading in the same way a filename is: not because a rule forbids it, but because the value does
 * not contain a decision.
 *
 * That also completes the ladder's intent. `Execution/OutcomeAdapter` brings V1 outcomes in,
 * `MarketContextAdapter` and `PatternAdapter` bring V1 observations in, and this one brings V1's
 * *verdict* in — as evidence about V1, never as an instruction to V2.2.
 *
 * ## Readable, deliberately not hashed
 *
 * `promotionBlocker` prints both sides: *"V1 said X, V2 said Y, and nothing explains it."* A digest
 * would satisfy equality and destroy that message, leaving a reviewer with two hashes and a blocked
 * promotion. Every unexplained divergence has to be diagnosable by the person reading it, so the
 * canonical form is legible.
 *
 * ## Prices are quantised, because float noise would swamp the real signal
 *
 * The comparison is string equality. Two theses agreeing to fifteen decimal places but formatted
 * differently would register as a divergence, land in `UNKNOWN` — the blocking bucket — and there
 * would be dozens of them for every real finding. That is exactly how an acceptance test becomes
 * unusable: this system has already had a parity check where 483 of 748 reported mismatches were
 * key-order artifacts, and the check got read as evidence.
 *
 * So prices are rounded to a declared number of decimals and rendered in a fixed layout. The rounding
 * is part of the comparison's definition, and `THESIS_COMPARISON_V1` versions it: a change to the
 * precision changes which theses count as equal, so it cannot be adjusted silently.
 *
 * ## The composite score is excluded, and that is not an omission
 *
 * V1's composite confidence is quarantined, and including it here would break P13 rather than enrich
 * it. V2.2 has no composite by design — it evaluates gate by gate — so a comparison carrying the
 * score would diverge on **every single row**, each one filed as
 * `EXPECTED_ARCHITECTURAL_CHANGE`. Hundreds of expected divergences is not a finding; it is noise
 * that hides the handful of rows that matter.
 *
 * What is compared is the *verdict and the geometry it implies* — what the system decided to do —
 * which is the thing both architectures are answerable for.
 */

export const thesisComparisonVersion = "THESIS_COMPARISON_V1";

/** Decimals prices are quantised to before comparison. Part of the versioned definition above. */
export const thesisComparisonPriceDecimals = 2;

export type LegacyThesisVerdict = "APPROVED" | "REJECTED" | "NO_ACTION";
export type LegacyThesisSide = "LONG" | "SHORT";

export interface LegacyThesis {
  readonly instrumentSymbol: string;
  /** The decision instant, which becomes half of the comparison key. */
  readonly decisionAt: Date;
  readonly verdict: LegacyThesisVerdict;
  /**
   * Null exactly when the verdict is not `APPROVED`.
   *
   * A rejected thesis has no geometry to compare, and inventing a neutral one would make two
   * different rejections look like the same decision.
   */
  readonly geometry: {
    readonly side: LegacyThesisSide;
    readonly entryPrice: number;
    readonly stopLoss: number;
    readonly targetPrice: number;
  } | null;
}

export interface ThesisComparison {
  /** Identifies the decision point both systems were asked about. */
  readonly comparisonKey: string;
  /** The canonical, legible outcome label. Compared by string equality. */
  readonly canonicalOutcome: string;
  readonly comparisonVersion: string;
}

export class ThesisAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ThesisAdapterError";
  }
}

function quantise(value: number, field: string): string {
  if (!Number.isFinite(value)) {
    throw new ThesisAdapterError(`${field} must be a finite number, not ${value}.`);
  }
  return value.toFixed(thesisComparisonPriceDecimals);
}

/**
 * Reduces a legacy thesis to the two strings P13 compares.
 *
 * Returns nothing executable. See the module note: that is the enforcement of §6's "not live
 * decisions", and it is why the return type carries no side, price or quantity.
 */
export function legacyThesisComparison(thesis: LegacyThesis): ThesisComparison {
  if (Number.isNaN(thesis.decisionAt.getTime())) {
    throw new ThesisAdapterError("A thesis comparison needs a valid decision instant.");
  }
  if (thesis.instrumentSymbol.trim() === "") {
    throw new ThesisAdapterError("A thesis comparison needs the instrument it was about.");
  }

  const approved = thesis.verdict === "APPROVED";
  if (approved && thesis.geometry === null) {
    throw new ThesisAdapterError(
      `${thesis.instrumentSymbol}: an APPROVED thesis must carry the geometry it approved. Comparing `
      + "an approval with no levels against another approval would report agreement between two "
      + "decisions that may have nothing in common.",
    );
  }
  if (!approved && thesis.geometry !== null) {
    /*
     * The reverse contradiction. A rejected thesis carrying geometry means V1 computed levels and
     * then declined -- which is real and interesting, but it is not part of what was *decided*, and
     * folding it into the outcome would make two rejections differ on levels neither acted on.
     */
    throw new ThesisAdapterError(
      `${thesis.instrumentSymbol}: a ${thesis.verdict} thesis must not carry geometry. Levels that `
      + "were never acted on would make two identical rejections compare as different.",
    );
  }

  const comparisonKey = `${thesis.instrumentSymbol}@${thesis.decisionAt.toISOString()}`;
  const canonicalOutcome = thesis.geometry === null
    ? thesis.verdict
    : [
      thesis.verdict,
      thesis.geometry.side,
      `entry=${quantise(thesis.geometry.entryPrice, "entryPrice")}`,
      `stop=${quantise(thesis.geometry.stopLoss, "stopLoss")}`,
      `target=${quantise(thesis.geometry.targetPrice, "targetPrice")}`,
    ].join(" ");

  return Object.freeze({
    comparisonKey,
    canonicalOutcome,
    comparisonVersion: thesisComparisonVersion,
  });
}
