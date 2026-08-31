import { describe, expect, it, vi } from "vitest";
import type { StrategyMarketContext } from "../../../strategy-engine/domain/strategy.js";
import { CaptureScalpResearchDecision, type ScalpResearchWritePort } from "./capture-research-decision.js";
import type { ResearchControlPoint } from "../domain/contracts.js";

/**
 * The frozen-tape gate at the capture boundary.
 *
 * Scoped deliberately to what a stub can prove: that `tapeLiveness` reaches the control builder, and
 * that a frozen bar creates no proposal, opportunity or risk subject. Proving the *positive* branch --
 * that a live bar does reach strategy evaluation -- needs a fixture that actually fires a momentum
 * strategy, which this does not build. The branch itself is one guard shared with the
 * already-shipped `featureCoverage === "INCOMPLETE"` path.
 */
function ist(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 7, 31, hour - 5, minute - 30));
}

function writePort(): ScalpResearchWritePort & { controls: ResearchControlPoint[]; proposals: number } {
  const state = {
    controls: [] as ResearchControlPoint[],
    proposals: 0,
    async saveStrategyDefinition() { return "definition-1"; },
    async saveProposal(proposal: never) {
      state.proposals += 1;
      return proposal;
    },
    async saveOpportunity(opportunity: never) { return opportunity; },
    async saveControlPoint(control: ResearchControlPoint) {
      state.controls.push(control);
      return { ...control, id: `control-${state.controls.length}` };
    },
    async saveRiskSnapshot(snapshot: never) { return snapshot; },
    async saveRiskSubject(subject: never) { return subject; },
    async saveRiskDecision() { return "risk-decision-1"; },
  };
  return state as unknown as ScalpResearchWritePort & { controls: ResearchControlPoint[]; proposals: number };
}

function reference(): StrategyMarketContext {
  return {
    candle: {
      id: "candle-1", instrumentId: "instrument-1", timeframe: "1m",
      openTime: ist(15, 20), closeTime: ist(15, 21),
      open: 24_308, high: 24_315, low: 24_306, close: 24_312, volume: 0, tickSize: 0.05,
    },
    indicators: [],
    patterns: [],
    priceActionEvents: [],
  } as unknown as StrategyMarketContext;
}

describe("capture on a frozen tape", () => {
  it("writes both control points marked TAPE_FROZEN and creates nothing else", async () => {
    /*
     * A 15:21 decision, inside the daily 15:16-to-close index freeze. `GRID_POLICY_V1` admits the
     * slot, the bar is complete and on grid, and 41 proposals had already been recorded in this
     * window before the gate existed.
     */
    const port = writePort();

    const result = await new CaptureScalpResearchDecision(port).execute({
      reference1mContext: reference(),
      strategyContexts: [reference()],
      sessionCloseAt: ist(15, 30),
      tickSize: 0.05,
      lotSize: 15,
      accountSnapshots: [],
      featureCoverage: "COMPLETE",
      tapeLiveness: "FROZEN",
    });

    expect(result.proposals).toBe(0);
    expect(result.opportunities).toBe(0);
    expect(result.riskSubjects).toBe(0);
    expect(port.proposals).toBe(0);

    // The grid point is still recorded. A hole would bias the matched-control population silently;
    // a row marked ineligible is something a reader can see and filter on.
    expect(result.controls).toBe(2);
    expect(port.controls.map((item) => item.evaluationDirection)).toEqual(["LONG", "SHORT"]);
    expect(port.controls.every((item) => item.ineligibleReason === "TAPE_FROZEN")).toBe(true);
    expect(port.controls.every((item) => item.sampleEligible === false)).toBe(true);
  });

  it("stamps the V3 control policy on a frozen point too", async () => {
    // The population version has to travel with every row, not only the eligible ones, or a later
    // audit cannot tell which rule declined the point.
    const port = writePort();

    await new CaptureScalpResearchDecision(port).execute({
      reference1mContext: reference(),
      strategyContexts: [reference()],
      sessionCloseAt: ist(15, 30),
      tickSize: 0.05,
      lotSize: 15,
      accountSnapshots: [],
      featureCoverage: "COMPLETE",
      tapeLiveness: "FROZEN",
    });

    expect(port.controls[0]!.controlPolicyVersion).toBe("MATCHED_CONTROL_POPULATION_V3:GRID_POLICY_V1");
  });

  it("does not consult the strategies at all when the tape is frozen", async () => {
    // Cheap proof that the guard sits ahead of evaluation rather than filtering results afterwards:
    // a frozen bar must not even read a strategy context.
    const port = writePort();
    const strategyContexts = [reference()];
    const spy = vi.spyOn(strategyContexts, "filter");

    await new CaptureScalpResearchDecision(port).execute({
      reference1mContext: reference(),
      strategyContexts,
      sessionCloseAt: ist(15, 30),
      tickSize: 0.05,
      lotSize: 15,
      accountSnapshots: [],
      featureCoverage: "COMPLETE",
      tapeLiveness: "FROZEN",
    });

    // Verified non-vacuous: flipping this call to "LIVE" fails with `filter` called 4 times, once
    // per registered research strategy.
    expect(spy).not.toHaveBeenCalled();
  });
});
