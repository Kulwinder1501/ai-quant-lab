/**
 * Which models may enter the directional model competition.
 *
 * Enrollment used to filter on `stage` alone, which admitted two kinds of member that
 * can never score, and both appeared in the live pool immediately:
 *
 * * **Non-directional models.** The volatility-expansion model was enrolled as PRIMARY of
 *   a BULLISH/BEARISH/NEUTRAL competition. It predicts CONTRACTION/STABLE/EXPANSION into
 *   `auxiliary_model_predictions`, so it has nothing in `model_predictions` to settle and
 *   sat permanently unpromotable at the top of its own group. The two label alphabets are
 *   disjoint by design and this competition scores exactly one of them.
 * * **Models on a superseded feature schema.** Every directional member was on
 *   `ml-feature-v1` or `ml-feature-v4`, which inference rejects outright, so none of them
 *   could produce a prediction to score.
 *
 * The result was a pool of 11 against a declared maximum of 8, none of whose members could
 * contribute a single settled directional prediction.
 */

/**
 * Label schemes whose target is a trade direction, and which therefore settle against
 * `model_predictions`' BULLISH/BEARISH/NEUTRAL alphabet.
 *
 * `volatility-expansion-v1` is deliberately absent: it is non-directional and belongs to
 * `auxiliary_model_predictions`. Adding a new directional scheme means adding it here.
 */
export const DIRECTIONAL_LABEL_SCHEMES = ["fixed-horizon-v1", "triple-barrier-v1"] as const;

/**
 * The feature-schema contract inference will accept today.
 *
 * This is an immutable ordered column contract shared with `apps/ml`; a model trained
 * against any other version is rejected when loaded. **Bump this string in the same change
 * that bumps the Python contract.** If it is ever left behind, the competition pool empties
 * rather than filling with unloadable models — the safe direction, and
 * `RunModelCompetitionResult` reports how many models each filter excluded so the cause is
 * visible rather than silent.
 */
export const CURRENT_FEATURE_SCHEMA_VERSION = "ml-feature-v5";

export interface CompetitionEligibilityFilter {
  directionalLabelSchemes: readonly string[];
  featureSchemaVersion: string;
}

export const defaultCompetitionEligibilityFilter: CompetitionEligibilityFilter = {
  directionalLabelSchemes: DIRECTIONAL_LABEL_SCHEMES,
  featureSchemaVersion: CURRENT_FEATURE_SCHEMA_VERSION,
};
