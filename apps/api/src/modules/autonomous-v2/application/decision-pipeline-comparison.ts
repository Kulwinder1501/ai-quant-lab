import { legacyThesisComparison } from "./thesis-adapter.js";
import type { DecisionPipelineRun } from "../domain/decision-pipeline.js";
import type { SideGeometry } from "../domain/thesis-builder.js";

/**
 * Canonicalizes a `DecisionPipelineRun` into the one comparable string P13's `differential-testing.ts`
 * expects on V2.2's side of a comparison.
 *
 * ## Why thesis, not execution
 *
 * V1's shadow comparison (via `legacyThesisComparison`) only ever answers "did V1 form a directional
 * idea, and what geometry" -- it has no equivalent of P8 (risk), P9 (instrument), or P10 (execution) in
 * this harness. Comparing this pipeline's `EXECUTED`/fill-level outcome against V1 would not be
 * apples-to-apples: V1 was never asked that question. So this reduces the pipeline to the same
 * thesis-level verdict `legacyThesisComparison` already produces for V1, reusing that exact function
 * (not re-implementing its quantisation) for byte-identical formatting.
 *
 * ## What "both sides approved" means
 *
 * `shadow-decision.ts`'s `canonicalV2Outcome` assumes exactly one side, because `NativeThesis` is
 * single-sided. This pipeline's thesis stage can approve zero, one, or **two** sides -- something V1
 * can never produce, since it never evaluates LONG and SHORT independently. Picking one arbitrarily
 * would hide that architectural difference behind a false agreement or a false divergence, so a
 * dual-approval is labelled distinctly (`APPROVED_BOTH_SIDES ...`) rather than collapsed -- letting a
 * human classify it honestly in P13's own classification step, which is not this adapter's job.
 */

export class DecisionPipelineComparisonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionPipelineComparisonError";
  }
}

function geometryOutcome(instrumentSymbol: string, side: SideGeometry): string {
  return legacyThesisComparison({
    instrumentSymbol,
    // Only the geometry is compared; the instant is carried by the comparison key, same posture
    // canonicalV2Outcome already takes.
    decisionAt: new Date(0),
    verdict: "APPROVED",
    geometry: {
      side: side.side,
      entryPrice: side.entryReference,
      stopLoss: side.stopLoss,
      targetPrice: side.targetPrice,
    },
  }).canonicalOutcome;
}

export function canonicalDecisionPipelineOutcome(run: DecisionPipelineRun): string {
  const thesis = run.stages.thesis;
  const longSide = thesis !== undefined && thesis.long.outcome === "APPROVED" ? thesis.long.value : null;
  const shortSide = thesis !== undefined && thesis.short.outcome === "APPROVED" ? thesis.short.value : null;

  if (longSide !== null && shortSide !== null) {
    return `APPROVED_BOTH_SIDES ${geometryOutcome(thesis!.instrumentSymbol, longSide)}`
      + ` | ${geometryOutcome(thesis!.instrumentSymbol, shortSide)}`;
  }

  const approvedSide = longSide ?? shortSide;
  if (approvedSide !== null) {
    return geometryOutcome(thesis!.instrumentSymbol, approvedSide);
  }

  // Neither side reached an approved thesis -- format from the pipeline's own stopping reason, the
  // same shape canonicalV2Outcome already uses for a V1 non-approval.
  switch (run.outcome.kind) {
    case "REJECTED": return `REJECTED ${[...run.outcome.reasons].sort().join(",")}`;
    case "DEFERRED": return `DEFERRED ${run.outcome.reason}`;
    case "CLOSED_NO_ACTION": return `NO_ACTION ${run.outcome.reason}`;
    case "EXECUTED":
      throw new DecisionPipelineComparisonError(
        "Pipeline reached EXECUTED with no approved thesis side recorded; the two are contradictory.",
      );
  }
}
