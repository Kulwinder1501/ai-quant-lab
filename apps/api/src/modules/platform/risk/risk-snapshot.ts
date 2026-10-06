/**
 * A point-in-time reading of account risk state. **Structure only — no thresholds, no policy.**
 *
 * ## Why this exists: two shapes of the same fact
 *
 * The repository already carries this reading twice, and the two agree on everything except the
 * field that matters:
 *
 * | Field | `RiskState` (risk-management) | `ResearchRiskSnapshotState` (scalp harness) |
 * | :--- | :--- | :--- |
 * | `accountEquity` | number | number |
 * | `peakEquity` | number | number |
 * | `openPositionCount` | number | number |
 * | `realizedPnlToday` | number | number |
 * | volatility evidence | `VolatilityRegimeEvidence \| null` — **one** instrument | `Record<instrumentId, evidence \| null>` — **every** instrument |
 *
 * Neither is wrong. `RiskState` is the narrowed view a single proposal needs; the harness generalised
 * it because one snapshot serves many instruments' subjects, and its own comment says so: "Account
 * state is global; subject-specific volatility evidence is held in a complete instrument map."
 *
 * So the general form is the primitive and the narrow one is derived from it. Writing the narrowing
 * down is the point — it is the step where the wrong instrument's evidence can be attached to a
 * proposal, and until now it existed only as whatever each call site happened to do.
 *
 * ## What is deliberately *not* here
 *
 * `RiskPolicy`, `defaultRiskPolicy`, `evaluateRisk`, `riskReasonCodes` and every sizing rule stay in
 * `risk-management`. Readiness Plan Gap 2 exists to stop the shared layer becoming a God Risk Engine:
 * the platform owns the shape of the reading and the enforcement mechanism, each domain owns the
 * thresholds it judges against. A number like `maxConcurrentPositions: 3` in this file would be that
 * boundary already broken.
 *
 * The evidence type is a **type parameter** for the same reason. The first draft imported
 * `VolatilityRegimeEvidence` from `risk-management`, which points the dependency the wrong way: the
 * platform would then know that regimes are `CONTRACTION | STABLE | EXPANSION`, which is a domain
 * fact about one strategy family. What the platform knows is that a snapshot carries *some* evidence
 * per instrument, completely. The domain says what evidence is.
 */

export interface AccountRiskSnapshot<TEvidence = unknown> {
  readonly asOf: Date;
  /** Realised equity at `asOf`. */
  readonly accountEquity: number;
  /** Highest realised equity ever reached, for a drawdown comparison the *domain* makes. */
  readonly peakEquity: number;
  readonly openPositionCount: number;
  /** Realised P&L booked today; negative when losing. */
  readonly realizedPnlToday: number;
  /**
   * Regime evidence for **every** instrument the snapshot covers.
   *
   * Complete by contract, which is what makes a missing key meaningful: see `narrowToInstrument`.
   */
  readonly volatilityEvidenceByInstrument: Readonly<Record<string, TEvidence | null>>;
}

/** The narrowed reading a single proposal is judged against. Shape-compatible with `RiskState`. */
export interface InstrumentRiskSnapshot<TEvidence = unknown> {
  readonly accountEquity: number;
  readonly peakEquity: number;
  readonly openPositionCount: number;
  readonly realizedPnlToday: number;
  readonly volatilityRegime: TEvidence | null;
}

export class InstrumentNotCoveredError extends Error {
  constructor(readonly instrumentId: string, readonly asOf: Date) {
    super(
      `Risk snapshot at ${asOf.toISOString()} does not cover instrument "${instrumentId}". `
      + "The evidence map is complete by contract, so an absent key means the snapshot was built "
      + "without this instrument -- not that it had no regime. Treating the two alike would judge a "
      + "proposal against evidence that was never gathered.",
    );
    this.name = "InstrumentNotCoveredError";
  }
}

export function sealRiskSnapshot<TEvidence>(
  snapshot: AccountRiskSnapshot<TEvidence>,
): Readonly<AccountRiskSnapshot<TEvidence>> {
  if (Number.isNaN(snapshot.asOf.getTime())) throw new Error("A risk snapshot needs a valid asOf instant.");
  for (const [field, value] of [
    ["accountEquity", snapshot.accountEquity],
    ["peakEquity", snapshot.peakEquity],
    ["realizedPnlToday", snapshot.realizedPnlToday],
  ] as const) {
    if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number.`);
  }
  if (!Number.isInteger(snapshot.openPositionCount) || snapshot.openPositionCount < 0) {
    throw new Error("openPositionCount must be a non-negative integer.");
  }
  if (snapshot.peakEquity < snapshot.accountEquity) {
    // Peak is a running maximum. A peak below current equity means whoever built this snapshot
    // computed the maximum over the wrong window, and every drawdown check downstream would
    // understate the drawdown.
    throw new Error("peakEquity cannot be below accountEquity: it is a running maximum.");
  }
  return Object.freeze({
    ...snapshot,
    volatilityEvidenceByInstrument: Object.freeze({ ...snapshot.volatilityEvidenceByInstrument }),
  });
}

/**
 * Narrows a global snapshot to the single instrument a proposal concerns.
 *
 * Throws when the instrument is absent rather than returning `null` evidence. The distinction is the
 * whole reason this function exists:
 *
 * - `null` evidence means *covered, and no regime could be established* — a legitimate reading the
 *   domain may act on.
 * - an absent key means *this snapshot was never built for this instrument* — a pipeline defect.
 *
 * Collapsing them would let a proposal be judged against evidence nobody gathered, which is
 * indistinguishable from a genuine "no regime" once stored. That is the same conflation that made an
 * earlier feature-coverage gap invisible, where "not computed" and "computed, found nothing" shared a
 * representation.
 */
export function narrowToInstrument<TEvidence>(
  snapshot: AccountRiskSnapshot<TEvidence>,
  instrumentId: string,
): InstrumentRiskSnapshot<TEvidence> {
  if (!Object.prototype.hasOwnProperty.call(snapshot.volatilityEvidenceByInstrument, instrumentId)) {
    throw new InstrumentNotCoveredError(instrumentId, snapshot.asOf);
  }
  return {
    accountEquity: snapshot.accountEquity,
    peakEquity: snapshot.peakEquity,
    openPositionCount: snapshot.openPositionCount,
    realizedPnlToday: snapshot.realizedPnlToday,
    volatilityRegime: snapshot.volatilityEvidenceByInstrument[instrumentId] ?? null,
  };
}
