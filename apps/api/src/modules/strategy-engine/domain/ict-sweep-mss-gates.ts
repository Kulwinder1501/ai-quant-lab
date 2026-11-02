import type { IctStateCompositeSnapshot } from "../../technical-analysis/domain/ict/config.js";
import { computeOteBandForLeg } from "../../technical-analysis/domain/ict/ote.js";
import { killzoneAt, type IctStructureStrategyConfiguration } from "./ict-structure-strategy.js";

/**
 * Which gate of the live ICT model (`ict-structure-v1` version 3, `SWEEP_MSS_RETRACE`) stopped a bar, and the one-line daily summary
 * built from it.
 *
 * The older gate report counted `alignment_status`, which is what the ALIGNMENT model reads. Version 3 does not read it: it needs a
 * liquidity sweep, a displacement shift through the opposing swing, then a retrace that taps and holds the leg's OTE band. On
 * 2026-11-02 that report called BANKNIFTY "71% bias and structure disagree", a gate version 3 never applies, while the strategy's own
 * funnel said "no shift" on most bars. A quiet day needs the right reason, or a broken strategy reads the same as a waiting one.
 *
 * This is a second statement of the gates in `IctStructureStrategy.evaluateSweepMssModel`, in the same order, because that method
 * returns an empty list without saying why. `ict-sweep-mss-gates.test.ts` runs both over the strategy's own scenarios and fails when
 * they disagree, so an edit to one that forgets the other is caught.
 */
export type SweepMssGate =
  | "COVERAGE_INCOMPLETE"
  | "NO_SHIFT"
  | "NO_ATR"
  | "BIAS_OPPOSES_SHIFT"
  | "SHIFT_TOO_OLD"
  | "OUTSIDE_KILLZONE"
  | "LEG_TOO_SMALL"
  | "NO_BAR_AFTER_BREAK"
  | "NOT_TAPPED_AND_HELD"
  | "ALREADY_RETRACED"
  | "RISK_OUT_OF_RANGE"
  | "TARGET_BEHIND_ENTRY"
  | "RISK_REWARD_TOO_LOW"
  | "WOULD_FIRE";

export interface SweepMssBar {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly openTime: Date;
}

/** The first gate that refuses this bar, or `WOULD_FIRE`. Mirrors `evaluateSweepMssModel` step for step. */
export function firstSweepMssGate(
  ict: IctStateCompositeSnapshot,
  bar: SweepMssBar,
  config: IctStructureStrategyConfiguration,
): SweepMssGate {
  const coverage = ict.coverage;
  if (coverage.structure !== "COMPLETE" || coverage.bias !== "COMPLETE" || coverage.htf !== "COMPLETE") return "COVERAGE_INCOMPLETE";

  const mss = ict.mss ?? null;
  if (mss === null) return "NO_SHIFT";

  const atr = ict.atr14;
  if (atr === null || atr <= 0 || Number.isNaN(atr)) return "NO_ATR";

  const isBullish = mss.direction === "BULLISH";
  if (ict.bias.bias !== mss.direction) return "BIAS_OPPOSES_SHIFT";
  if (ict.htfBias && ict.htfBias !== mss.direction) return "BIAS_OPPOSES_SHIFT";

  if (mss.barsSinceBreak > config.mssMaxAgeBars) return "SHIFT_TOO_OLD";
  if (config.requireKillzone && killzoneAt(bar.openTime) === null) return "OUTSIDE_KILLZONE";

  const band = computeOteBandForLeg(mss.legStart, mss.legEnd, mss.direction);
  if (band === null || band.span < config.mssMinLegAtr * atr) return "LEG_TOO_SMALL";

  let entryPrice: number;
  if (config.entryModel === "SWEEP_MSS_RETRACE") {
    if (mss.barsSinceBreak < 1) return "NO_BAR_AFTER_BREAK";
    const tappedAndHeld = isBullish
      ? bar.low <= band.bandHigh && bar.close >= band.bandLow && bar.close > bar.open
      : bar.high >= band.bandLow && bar.close <= band.bandHigh && bar.close < bar.open;
    if (!tappedAndHeld) return "NOT_TAPPED_AND_HELD";
    entryPrice = bar.close;
  } else {
    const notYetRetraced = isBullish ? bar.close > band.level : bar.close < band.level;
    if (!notYetRetraced) return "ALREADY_RETRACED";
    entryPrice = band.level;
  }

  const buffer = config.mssStopBufferAtr * atr;
  const stopLoss = isBullish ? mss.legStart - buffer : mss.legStart + buffer;
  if (isBullish ? entryPrice <= stopLoss : entryPrice >= stopLoss) return "RISK_OUT_OF_RANGE";
  const riskDistance = Math.abs(entryPrice - stopLoss);
  if (riskDistance < config.mssMinRiskAtr * atr || riskDistance / atr > config.maxRiskDistanceAtr) return "RISK_OUT_OF_RANGE";

  const legObjective = mss.legEnd;
  if (isBullish ? legObjective <= entryPrice : legObjective >= entryPrice) return "TARGET_BEHIND_ENTRY";
  const targetPrice = isBullish
    ? Math.min(legObjective, entryPrice + config.maxTargetR * riskDistance)
    : Math.max(legObjective, entryPrice - config.maxTargetR * riskDistance);
  const riskReward = Number((Math.abs(targetPrice - entryPrice) / riskDistance).toFixed(2));
  if (riskReward < config.minimumRiskReward) return "RISK_REWARD_TOO_LOW";

  return "WOULD_FIRE";
}

const GATE_LABELS: Readonly<Record<SweepMssGate, string>> = {
  COVERAGE_INCOMPLETE: "a pillar is missing",
  NO_SHIFT: "no market structure shift",
  NO_ATR: "no ATR yet",
  BIAS_OPPOSES_SHIFT: "daily/HTF bias opposes the shift",
  SHIFT_TOO_OLD: "shift older than the allowed age",
  OUTSIDE_KILLZONE: "outside the killzone",
  LEG_TOO_SMALL: "leg too small to retrace",
  NO_BAR_AFTER_BREAK: "no bar since the break yet",
  NOT_TAPPED_AND_HELD: "retrace has not tapped and held the OTE band",
  ALREADY_RETRACED: "price already retraced",
  RISK_OUT_OF_RANGE: "stop too tight or too wide",
  TARGET_BEHIND_ENTRY: "target behind the entry",
  RISK_REWARD_TOO_LOW: "risk-reward below the floor",
  WOULD_FIRE: "setup would fire",
};

export function sweepMssGateLabel(gate: SweepMssGate): string {
  return GATE_LABELS[gate];
}

export interface SweepMssGateSummary {
  readonly bars: number;
  /** Bars carrying a live shift: every bar that was not stopped by missing coverage or by having no shift at all. */
  readonly barsWithShift: number;
  readonly gates: ReadonlyArray<{ readonly gate: SweepMssGate; readonly bars: number }>;
  readonly wouldFire: number;
  readonly ideas: number;
  readonly trades: number;
  /** Bot runs that day that failed because a strategy threw. Non-zero means the funnel above was not what the bot saw. */
  readonly strategyErrorRuns: number;
}

export function summariseSweepMssGates(
  gates: readonly SweepMssGate[],
  counts: { ideas: number; trades: number; strategyErrorRuns: number },
): SweepMssGateSummary {
  const tally = new Map<SweepMssGate, number>();
  for (const gate of gates) tally.set(gate, (tally.get(gate) ?? 0) + 1);
  const ordered = [...tally.entries()]
    .map(([gate, bars]) => ({ gate, bars }))
    .sort((a, b) => b.bars - a.bars || a.gate.localeCompare(b.gate));
  return {
    bars: gates.length,
    barsWithShift: gates.filter((gate) => gate !== "NO_SHIFT" && gate !== "COVERAGE_INCOMPLETE").length,
    gates: ordered,
    wouldFire: tally.get("WOULD_FIRE") ?? 0,
    ideas: counts.ideas,
    trades: counts.trades,
    strategyErrorRuns: counts.strategyErrorRuns,
  };
}

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;

export function formatSweepMssGateLine(date: string, cell: string, summary: SweepMssGateSummary): string {
  if (summary.bars === 0) return `ICT v3 ${date} ${cell}: no bars recorded (market closed, or the capture did not run)`;
  const parts = summary.gates.map((item) => `${percent(item.bars, summary.bars)} ${sweepMssGateLabel(item.gate)}`);
  const errors = summary.strategyErrorRuns > 0
    ? ` | STRATEGY ERRORS in ${summary.strategyErrorRuns} bot run(s): the bot could not evaluate these bars`
    : "";
  // A setup that would fire with no idea behind it is the failure this report exists to expose.
  const gap = summary.wouldFire > 0 && summary.ideas === 0 ? " | SETUP WOULD HAVE FIRED BUT NO IDEA WAS RAISED" : "";
  return `ICT v3 ${date} ${cell}: ${summary.bars} bars, shift live on ${summary.barsWithShift} | ${parts.join(", ")} | ideas ${summary.ideas}, trades ${summary.trades}${gap}${errors}`;
}
