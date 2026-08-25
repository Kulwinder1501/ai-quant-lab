import { sha256Canonical } from "./identity.js";
import { canonicalFrictionRungsBps } from "./canonical-friction.js";
import { matchedControlCount, matchedControlMinuteCaliper } from "./matched-controls.js";

/**
 * Pre-registration for the exit-geometry falsification program — the studies, frozen before they run.
 *
 * ## Why registration has to precede the first result
 *
 * Every negative this project has recorded was reached by narrowing a search until something looked
 * alive, then asking whether the survivor was real. That question is unanswerable after the fact: a
 * winning cell out of 35 and a winning cell out of 350 look identical in a report, and the only
 * difference — how many configurations were examined — is exactly the part nobody writes down. The
 * deflated Sharpe ratio and probability-of-backtest-overfitting corrections both need the trial count
 * as an *input*; reconstructing it from memory after the fact makes the correction decorative.
 *
 * So the parameter sets are frozen here, hashed, and stored before any of them is executed. A study
 * that later wants a different horizon list or a wider grid is a *new* study with a new key — never an
 * edit. `PATH_STUDY_V1` plus a follow-up `PATH_STUDY_V2` is two trials and is accounted as two; a
 * silently widened `PATH_STUDY_V1` is one trial that has been lied about.
 *
 * ## What is deliberately not in here
 *
 * The trial *ledger* — one row per executed configuration, carrying `executedAt`, dataset cutoff,
 * session range and code version. It is required before any geometry cell is searched, and it is
 * intentionally left to the migration that lands the study runner, so its columns are determined by a
 * real writer rather than guessed at here. No trial can execute unrecorded, because the runner and its
 * table arrive together.
 */

export const studyRegistryEncodingVersion = "STUDY_REGISTRY_V1";

/**
 * Whether a study's candidate values were chosen before seeing outcomes from the data it will run on.
 *
 * Not a quality judgement and not a filter — a post-hoc family is a legitimate hypothesis and refusing
 * to register it would only mean testing it unrecorded. It is a *provenance* flag, because a
 * pre-specified grid and a family reverse-engineered from two good sessions carry different evidential
 * weight, and a multiplicity correction that flattens both into "one more parameter family" is wrong in
 * the direction that flatters us.
 */
export type StudyProvenance = "PRE_SPECIFIED" | "DATA_INSPECTED";

export interface StudyDefinition {
  /** Immutable identity. A changed specification requires a new key, never an edit to this one. */
  readonly studyKey: string;
  /** The single question this study is capable of answering, stated so a later reader cannot drift it. */
  readonly question: string;
  readonly provenance: StudyProvenance;
  /** Where the candidate values came from. Required, and required to be honest, for DATA_INSPECTED. */
  readonly provenanceNote: string;
  /** The frozen parameter set. Hashed verbatim, so any change is detectable. */
  readonly specification: Readonly<Record<string, unknown>>;
}

/**
 * How much independent evidence a result rests on, as a governance label rather than a test.
 *
 * Trade count is not sample size here. Intraday outcomes inside one session share a regime, a trend
 * and overlapping forward windows, so the independent unit is the trading day — which is why the
 * day-clustered bootstrap refuses an interval below two distinct days. But clearing that mechanical
 * floor is not the same as being allowed to kill or promote a strategy family, and conflating the two
 * is how a two-day reading becomes a verdict. These bands exist so a report has to *say* which it is.
 */
export type StudyEvidenceState =
  | "EARLY_DIAGNOSTIC"
  | "PROVISIONAL"
  | "RESEARCH_USABLE"
  | "STRONGER_VALIDATION";

/**
 * The session count below which a study may not kill or advance a hypothesis.
 *
 * Twenty independent sessions is a judgement, not a theorem: it is the point at which the day-clustered
 * interval stops being dominated by a single day's draw. Named here so a gate decision cites a frozen
 * number instead of whatever the current sample happens to support.
 */
export const decisionGradeSessionMinimum = 20;

export function evidenceState(sessionCount: number): StudyEvidenceState {
  if (!Number.isInteger(sessionCount) || sessionCount < 0) {
    throw new Error("Evidence state needs a non-negative whole number of sessions.");
  }
  if (sessionCount < 5) return "EARLY_DIAGNOSTIC";
  if (sessionCount < decisionGradeSessionMinimum) return "PROVISIONAL";
  if (sessionCount < 60) return "RESEARCH_USABLE";
  return "STRONGER_VALIDATION";
}

/** Whether a result at this session count may be used to kill or advance a hypothesis. */
export function decisionGrade(sessionCount: number): boolean {
  return sessionCount >= decisionGradeSessionMinimum;
}

/**
 * STAGE G1 — does the entry carry information at all, with no bracket attached?
 *
 * The point of a barrier-free study is that it cannot be steered by the exit policy it is meant to
 * inform. Every existing settled row is barrier-truncated: `walkPath` returns the instant a stop or
 * target is touched, so the stored 5/15/30/60-minute observations answer "what did this bracket do by
 * horizon H", not "where did price go by horizon H". Those are different objects, and using the second
 * to choose a bracket would be circular.
 */
const pathStudyV1: StudyDefinition = {
  studyKey: "PATH_STUDY_V1",
  question:
    "Do selected opportunities have a better control-adjusted forward path than matched controls, and "
    + "at which horizon does that advantage peak and decay?",
  provenance: "PRE_SPECIFIED",
  provenanceNote:
    "Horizon ladder chosen for even coverage of the 1m-to-60m range before any forward-path figure was "
    + "computed. No horizon was added or removed after inspecting a curve.",
  specification: {
    horizonsMinutes: [1, 2, 3, 5, 10, 15, 20, 30, 45, 60],
    /** Units reported side by side: points is instrument-specific, bps and ATR are comparable. */
    returnUnits: ["POINTS", "BPS", "ATR"],
    /*
     * Distributional statistics, not just the mean.
     *
     * A positive mean with a negative median says a handful of runners carries the whole result, which
     * argues for a wide target; a positive median with a weak mean says the edge is broad and shallow,
     * which argues for a tight one. Reporting only the mean cannot distinguish the two, and those two
     * findings imply opposite exit designs.
     */
    statistics: [
      "MEAN_DIRECTIONAL_RETURN", "MEDIAN_DIRECTIONAL_RETURN", "P_RETURN_POSITIVE",
      "MEAN_MFE", "MEDIAN_MFE", "MEAN_MAE", "MEDIAN_MAE",
      "MEDIAN_TIME_TO_MFE", "MEDIAN_TIME_TO_MAE", "GIVE_BACK_RATIO",
    ],
    /*
     * Pinned because it changes shape without a bracket.
     *
     * In the bracket world give-back was measured against a fill. Barrier-free has no fill, so it is
     * the share of the best point reached by horizon h that had been surrendered by the close of h.
     * Left informal, two implementers would reasonably write two different formulas.
     */
    giveBackRatioDefinition: "(mfe_h - directionalReturn_h) / mfe_h, undefined when mfe_h <= 0",
    /*
     * Reported per horizon, because horizon eligibility is not constant across the session.
     *
     * A decision late in the day cannot support a 60-minute horizon, so the population eligible at
     * +60m is systematically earlier-in-session than the one eligible at +1m. Left unreported, a real
     * time-of-day effect reads as information decay. The second curve restricts to decisions eligible
     * at *every* horizon, so the two can be compared: divergence between them is a time-of-day
     * finding, not noise.
     */
    eligibilityReporting: ["PER_HORIZON_ELIGIBLE_DECISIONS", "PER_HORIZON_ELIGIBLE_SESSIONS"],
    secondaryCurve: "COMMON_ELIGIBLE_SUBSET — decisions eligible at every horizon in the ladder",
    /*
     * Partition keys, never aggregation keys.
     *
     * The score gate decided what got *recorded* before it was lifted, so a gated population and an
     * ungated one are different selection rules answering different questions. Their mean describes a
     * strategy that never ran. `assertSingleCohort` already throws on this in the estimators; stating
     * it in the study definition means the first stage cannot quietly pool either.
     */
    groupBy: ["STRATEGY_DEFINITION_HASH", "INSTRUMENT", "TIMEFRAME", "DIRECTION"],
    controlPolicy: {
      matchedControlCount,
      matchedControlMinuteCaliper,
      note: "Existing matched-control policy, unchanged: same instrument, session, direction and "
        + "volatility regime inside the minute caliper, outcome-blind, full common support required.",
    },
    inference: "TRADING_DAY_BLOCK_BOOTSTRAP",
    barrierPolicy: "NONE — the walker ignores stop, target and timeout entirely",
    decisionGradeSessionMinimum,
  },
};

/**
 * STAGE G3 — which stop/target regions monetize the information, if any does.
 *
 * Gated behind G1 on purpose. Sweeping 35 cells over a population with no established control-adjusted
 * edge produces a winning cell by multiplicity, and the two sweeps this project has already run
 * (`NO_VIABLE_HORIZON`, `NO_VIABLE_STOP_MULTIPLE`) both moved stop and target *together* at a fixed
 * 1.5 reward-to-risk — one diagonal through a two-dimensional space. Whether 1.5 is the right ratio has
 * therefore never been tested, only assumed, and this grid is what separates the two axes.
 */
const geometryMatrixV1: StudyDefinition = {
  studyKey: "GEOMETRY_MATRIX_V1",
  question:
    "Over a jointly varied stop and target grid, which cells produce positive net expectancy "
    + "(monetization) and which produce positive selected-minus-control edge (selection)?",
  provenance: "PRE_SPECIFIED",
  provenanceNote:
    "Grid bounds chosen to bracket the incumbent 1.0-ATR stop / 1.5-R target on both axes and to span "
    + "reward-to-risk ratios from 0.17 to 6.0. Deliberately small: a larger grid buys resolution at the "
    + "cost of a multiplicity correction that would consume the result.",
  specification: {
    stopAtrMultiples: [0.5, 0.75, 1.0, 1.25, 1.5],
    targetAtrMultiples: [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0],
    cellCount: 35,
    incumbentCell: { stopAtrMultiple: 1.0, targetAtrMultiple: 1.5 },
    /*
     * Both surfaces, separately.
     *
     * Monetization asks whether the cell makes money; selection asks whether the strategy picked
     * better states than matched controls under that same cell. A cell can be positive on one and flat
     * on the other, and the two combinations mean opposite things — geometry that works on any input
     * versus information that no geometry monetizes.
     */
    surfaces: {
      MONETIZATION: "E[net selected outcome | stop, target]",
      SELECTION: "E[selected outcome | stop, target] - E[matched control outcome | stop, target]",
    },
    controlsRunOnIdenticalGrid: true,
    frictionRungsBps: canonicalFrictionRungsBps,
    /*
     * Cost in risk units scales as the inverse of the stop distance, so the tight rows of this grid pay
     * materially more than the wide ones for the identical basis-point assumption. Reporting cost in
     * bps alone would hide that entirely — it is constant at twice the rung — which is exactly the
     * mechanism that makes a tight bracket look attractive gross and fail net.
     */
    costReporting: ["GROSS_R", "FRICTION_R_PER_RUNG", "NET_R_PER_RUNG", "GROSS_BPS", "NET_BPS_PER_RUNG"],
    /*
     * A neighbourhood requirement, not a maximum.
     *
     * An isolated winning cell surrounded by losers is the signature of a lucky draw, since adjacent
     * geometries see almost the same trades. Stating the acceptance rule before the surface is computed
     * is what stops it from being redrawn around whichever cell wins.
     */
    acceptanceRule:
      "A candidate must sit in a contiguous region of same-signed cells, hold across instruments or "
      + "carry a stated reason for specialisation, and survive the friction ladder. A single cell "
      + "outperforming its neighbours is rejected as overfit.",
    groupBy: ["STRATEGY_DEFINITION_HASH", "INSTRUMENT", "TIMEFRAME", "DIRECTION"],
    ambiguityReporting: "PER_CELL — the ambiguous share rises as the bracket narrows toward the bar "
      + "range, so a single global figure understates it in exactly the tight cells where it binds.",
    gatedBehind: "PATH_STUDY_V1",
    decisionGradeSessionMinimum,
  },
};

/**
 * The fixed-point challenger family, registered *as* a post-hoc hypothesis.
 *
 * These levels came from looking at two sessions' outcomes. That does not disqualify them — it is a
 * real hypothesis and testing it unrecorded would be worse — but it does mean they cannot be counted
 * alongside a pre-specified grid when the multiplicity correction runs. The provenance flag is the
 * whole point of the entry.
 *
 * Also volatility-unnormalised, which is why BANKNIFTY gets an ATR-equivalent arm rather than the same
 * raw numbers: a 10-point NIFTY50 move and a 10-point BANKNIFTY move are not the same event.
 */
const fixedPointsV1: StudyDefinition = {
  studyKey: "FIXED_POINTS_V1",
  question:
    "Does a fixed point target outperform the volatility-normalised grid on the instrument and "
    + "timeframe it was observed on?",
  provenance: "DATA_INSPECTED",
  provenanceNote:
    "Candidate levels 10/15/20 points were selected after observing 2026-08-24 and 2026-08-25 scalp "
    + "outcomes. Registered so the multiplicity accounting can treat them as post-hoc rather than "
    + "pre-specified; they must not be pooled with GEOMETRY_MATRIX_V1's trial count.",
  specification: {
    nifty50TargetPoints: [10, 15, 20],
    banknifty: "ATR_EQUIVALENT — the NIFTY50 levels mapped through ATR rather than reused raw, since "
      + "the two instruments do not share a volatility scale.",
    role: "SECONDARY_CHALLENGER — reported beside the primary grid, never as its own conclusion.",
    groupBy: ["STRATEGY_DEFINITION_HASH", "INSTRUMENT", "TIMEFRAME", "DIRECTION"],
    gatedBehind: "PATH_STUDY_V1",
    decisionGradeSessionMinimum,
  },
};

export const registeredStudies: readonly StudyDefinition[] = [
  pathStudyV1,
  geometryMatrixV1,
  fixedPointsV1,
];

/**
 * The definition's content hash — the value a re-registration is checked against.
 *
 * Covers the specification and its provenance, so widening a grid or reclassifying a post-hoc family
 * as pre-specified both change it. It deliberately does *not* cover the runner's source, for the same
 * reason the research manifest does not: an unchanged hash proves the declared policy is unchanged, and
 * says nothing about the implementation. Code provenance belongs on the trial row, next to the result
 * it produced.
 */
export function studyDefinitionHash(definition: StudyDefinition): string {
  return sha256Canonical({
    encoding: studyRegistryEncodingVersion,
    studyKey: definition.studyKey,
    question: definition.question,
    provenance: definition.provenance,
    provenanceNote: definition.provenanceNote,
    specification: definition.specification,
  });
}

/** Rejects a definition that cannot serve as a registration before it reaches the table. */
export function assertStudyRegistrable(definition: StudyDefinition): void {
  if (!/^[A-Z0-9_]+_V[0-9]+$/.test(definition.studyKey)) {
    throw new Error(
      `Study key ${definition.studyKey} must be upper snake case ending in an explicit version, so a `
      + "changed specification is registered as a new study rather than edited in place.",
    );
  }
  if (definition.question.trim().length === 0) {
    throw new Error(`${definition.studyKey} needs the question it is capable of answering.`);
  }
  if (definition.provenanceNote.trim().length === 0) {
    throw new Error(
      `${definition.studyKey} needs a provenance note. For a DATA_INSPECTED study it must say which `
      + "observations the candidate values were drawn from.",
    );
  }
  if (Object.keys(definition.specification).length === 0) {
    throw new Error(`${definition.studyKey} has an empty specification, so nothing is actually frozen.`);
  }
}
