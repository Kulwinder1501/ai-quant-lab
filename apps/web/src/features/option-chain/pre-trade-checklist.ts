/**
 * A checklist to run through before buying one option, by hand. Pure, no React.
 *
 * It takes the figures the contract cost card already derives (`contract-cost.ts`) plus the viewer's own plan (stop, target, time
 * limit, a reason, and how much they are willing to lose) and says, check by check, whether each one clears a stated rule. Every
 * rule is printed on the screen next to its result.
 *
 * ## What the rules are
 * Rules of thumb, not tested thresholds. The cut-offs (a spread of 2% and 5%, charges of 10% and 20% of the risk, three days to expiry)
 * are conventional and were chosen before looking at any result; none has been shown to predict profit. They are in
 * `CHECKLIST_RULES` so they are in one place and can be changed on purpose.
 *
 * ## What it does not say
 * It is not a signal, a probability of profit or a recommendation to trade or not to trade. A trade can pass every check and lose,
 * and the checks do not say which way the index will go: they only guard against costs, bad quotes, tight stops and oversized
 * positions. The person decides. A check with no data says "unknown", never "pass", and a check that is not scored says so.
 */
import type { ContractCost, OptionSide } from "./contract-cost";

export type CheckStatus = "pass" | "caution" | "fail" | "unknown" | "not-scored";

export interface CheckResult {
  id: "charges" | "spread" | "time" | "iv" | "levels" | "exit-plan" | "stop-noise" | "size";
  title: string;
  status: CheckStatus;
  /** The measured figure, in one line. */
  value: string;
  /** What it means here, or what is missing. */
  detail: string;
  /** The rule this result was judged by, in words. */
  rule: string;
}

export const CHECKLIST_RULES = {
  /** Round-trip charges as a share of the rupees at risk at the stop. */
  chargesShareOfRisk: { pass: 0.10, caution: 0.20 },
  /** Ask minus bid over the mid, in percent. */
  spreadPercentOfMid: { pass: 2, caution: 5 },
  /** Calendar days to expiry: under `fail` is a fail, under `caution` a caution. */
  daysToExpiry: { fail: 1, caution: 3 },
  /**
   * What theta would take over the time you plan to hold, as a percent of the ask. Judged over the hold, not per day: a weekly at-the-money
   * call loses about 14% of its premium a calendar day, so a per-day rule would fail every weekly whatever the trade.
   */
  thetaOverHoldPercentOfAsk: { caution: 3, fail: 6 },
  /** A sentence, not a word: the reason box must hold at least this many characters. */
  minReasonLength: 20,
  /** Reward over risk at the plan's target and stop, after charges. */
  minNetRewardToRisk: 1,
  /**
   * The stop's distance in index points against a typical move over your hold. At or above `pass` times that move is a pass, at or above
   * `caution` times it a caution, below that a fail: a stop inside normal movement is hit by ordinary noise. The closed paper trades
   * with the smallest rupee risk (the tightest stops) lost the most per unit of risk even before charges.
   */
  stopOverTypicalMove: { pass: 1, caution: 0.5 },
  /** Trading minutes in an NSE session (09:15-15:30), for scaling a typical day's move down to a hold. */
  tradingMinutesPerDay: 375,
} as const;

export interface PlanInput {
  /** Premium at which the position is closed at a loss, per unit. */
  stopPremium: number | null;
  /** Premium at which the position is closed at a gain, per unit. */
  targetPremium: number | null;
  /** The longest the person will hold it, in minutes. */
  holdMinutes: number | null;
  /** Why the index should move, by about how much, by when. */
  reason: string;
  /** The most the person will lose on this trade, in rupees, charges included. */
  riskBudgetInr: number | null;
}

/** Round-trip charges for n lots at the entry premium: `flatInr + perLotInr * n`. Brokerage is flat per order, the rest scales. */
export interface FeeModel {
  lotSize: number;
  flatInr: number;
  perLotInr: number;
}

/**
 * Fit the charges line from the API's round-trip estimate at one lot and at two lots (same premium). Every variable charge is
 * proportional to the quantity and brokerage is flat, so two points give the line exactly, up to paise rounding.
 */
export function feeModelFromEstimates(lotSize: number, roundTripOneLot: number, roundTripTwoLots: number): FeeModel | null {
  if (![lotSize, roundTripOneLot, roundTripTwoLots].every(Number.isFinite) || !(lotSize > 0)) return null;
  const perLotInr = roundTripTwoLots - roundTripOneLot;
  if (perLotInr < 0) return null;
  // Paise rounding can leave the intercept a hair below zero; a negative flat charge is not a thing.
  return { lotSize, flatInr: Math.max(0, roundTripOneLot - perLotInr), perLotInr };
}

export function feesForLots(model: FeeModel, lots: number): number {
  return model.flatInr + model.perLotInr * lots;
}

/** A strike's open interest, in underlying units (Fyers `oi`), for finding the largest wall on each side of the index. */
export interface OiWallStrike {
  strike: number;
  callOi: number | null;
  putOi: number | null;
}

export interface OiWalls {
  /** The strike above the index with the most call open interest, among the strikes loaded. */
  callWall: { strike: number; oi: number } | null;
  /** The strike below the index with the most put open interest. */
  putWall: { strike: number; oi: number } | null;
}

/** Largest call OI strictly above the index and largest put OI strictly below it. A strike with no (or zero) OI is not a wall. */
export function findOiWalls(strikes: OiWallStrike[], spot: number | null): OiWalls {
  if (spot === null || !(spot > 0)) return { callWall: null, putWall: null };
  let callWall: OiWalls["callWall"] = null;
  let putWall: OiWalls["putWall"] = null;
  for (const row of strikes) {
    if (row.strike > spot && row.callOi !== null && row.callOi > 0 && (callWall === null || row.callOi > callWall.oi)) callWall = { strike: row.strike, oi: row.callOi };
    if (row.strike < spot && row.putOi !== null && row.putOi > 0 && (putWall === null || row.putOi > putWall.oi)) putWall = { strike: row.strike, oi: row.putOi };
  }
  return { callWall, putWall };
}

export interface ChecklistInput {
  side: OptionSide;
  cost: ContractCost | null;
  /** The contract-staleness sentence for this contract, when one is raised. */
  quoteWarning: string | null;
  plan: PlanInput;
  fees: FeeModel | null;
  walls: OiWalls | null;
  spot: number | null;
  /** The expected absolute daily move of the index in points, as a low-high band from the implied-move panel. */
  typicalDay: { low: number; high: number } | null;
}

export interface Sizing {
  /** Lots the budget allows, or null when no budget was given. Zero means it does not cover one lot. */
  lots: number | null;
  /** The lots every other figure here is worked at: the sized lots, or one lot when the budget covers none. */
  basisLots: number;
  quantity: number;
  /** Rupees lost if the stop is hit, charges included. */
  lossAtStop: number;
  /** Rupees gained if the target is hit, charges taken off. Null without a valid target. */
  gainAtTarget: number | null;
  /** Round-trip charges at the entry premium. */
  charges: number;
  /** Charges as a share of the rupees at risk at the stop, before charges. */
  chargesShareOfRisk: number;
  /** The premium paid for the position, before charges. */
  premiumPaid: number;
  netRewardToRisk: number | null;
}

const RANK: Record<"pass" | "caution" | "fail", number> = { pass: 0, caution: 1, fail: 2 };

function worst(...statuses: Array<"pass" | "caution" | "fail">): "pass" | "caution" | "fail" {
  return statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "pass" as "pass" | "caution" | "fail");
}

function inr(value: number): string {
  return `₹${Math.round(value).toLocaleString("en-IN")}`;
}

function two(value: number): string {
  return value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value: number, digits = 1): string {
  return `${value.toFixed(digits)}%`;
}

function positive(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

/** The plan is usable for sums only when the stop is below the ask and the lot size and charges are known. */
export function buildSizing(ask: number | null, plan: PlanInput, fees: FeeModel | null): Sizing | null {
  if (!positive(ask) || !positive(plan.stopPremium) || plan.stopPremium >= ask || fees === null) return null;
  const lossPerLot = (ask - plan.stopPremium) * fees.lotSize;
  // Largest n with n * lossPerLot + charges(n) <= budget. Charges are priced at the entry premium on both legs: a little more than
  // the real exit, which is at the stop, so the sizing errs towards fewer lots.
  const lots = positive(plan.riskBudgetInr) ? Math.max(0, Math.floor((plan.riskBudgetInr - fees.flatInr) / (lossPerLot + fees.perLotInr))) : null;
  const basisLots = lots !== null && lots >= 1 ? lots : 1;
  const quantity = basisLots * fees.lotSize;
  const charges = feesForLots(fees, basisLots);
  const riskBeforeCharges = lossPerLot * basisLots;
  const lossAtStop = riskBeforeCharges + charges;
  const gainAtTarget = positive(plan.targetPremium) && plan.targetPremium > ask ? (plan.targetPremium - ask) * quantity - charges : null;
  return {
    lots,
    basisLots,
    quantity,
    lossAtStop,
    gainAtTarget,
    charges,
    chargesShareOfRisk: charges / riskBeforeCharges,
    premiumPaid: ask * quantity,
    netRewardToRisk: gainAtTarget !== null && lossAtStop > 0 ? gainAtTarget / lossAtStop : null,
  };
}

function chargesCheck(sizing: Sizing | null): CheckResult {
  const rule = `Pass if round-trip charges are at most ${pct(CHECKLIST_RULES.chargesShareOfRisk.pass * 100, 0)} of the rupees at risk at your stop, caution up to ${pct(CHECKLIST_RULES.chargesShareOfRisk.caution * 100, 0)}, fail above. Charges are a fixed cost of about ₹47 plus a share of the premium, so a tight stop makes them a large part of what you risk.`;
  if (sizing === null) {
    return { id: "charges", title: "Charges against the risk", status: "unknown", value: "–", detail: "Needs a two-sided quote, a stop below the ask, and the lot size and charges from the API.", rule };
  }
  const share = sizing.chargesShareOfRisk;
  const status = share <= CHECKLIST_RULES.chargesShareOfRisk.pass ? "pass" : share <= CHECKLIST_RULES.chargesShareOfRisk.caution ? "caution" : "fail";
  return {
    id: "charges",
    title: "Charges against the risk",
    status,
    value: `${inr(sizing.charges)} round trip = ${pct(share * 100)} of the ${inr(sizing.lossAtStop - sizing.charges)} at risk`,
    detail: `Worked at ${sizing.basisLots} lot${sizing.basisLots === 1 ? "" : "s"}. Charges are paid win or lose; the stop loses ${inr(sizing.lossAtStop)} in all.`,
    rule,
  };
}

function spreadCheck(cost: ContractCost | null, quoteWarning: string | null): CheckResult {
  const r = CHECKLIST_RULES.spreadPercentOfMid;
  const rule = `Pass if the bid-ask spread is at most ${r.pass}% of the mid, caution up to ${r.caution}%, fail above. A contract with no bid or no ask fails: an unquoted contract is unknown, not cheap. A repeated (stale) quote lowers a pass to a caution.`;
  if (cost === null) return { id: "spread", title: "Spread and quote", status: "unknown", value: "–", detail: "No contract is selected.", rule };
  if (cost.quote === null) {
    return { id: "spread", title: "Spread and quote", status: "fail", value: "no two-sided quote", detail: "There is no bid, or no ask, or a crossed pair, so there is no price to pay and no spread.", rule };
  }
  const spread = cost.quote.spreadPercentOfMid;
  let status: "pass" | "caution" | "fail" = spread <= r.pass ? "pass" : spread <= r.caution ? "caution" : "fail";
  if (quoteWarning !== null) status = worst(status, "caution");
  return {
    id: "spread",
    title: "Spread and quote",
    status,
    value: `${two(cost.quote.bid)} / ${two(cost.quote.ask)} · spread ${pct(spread, 2)} of mid`,
    detail: quoteWarning ?? `Getting in and out at once costs ${pct(cost.roundTripPercentOfAsk ?? 0, 2)} of the ask.`,
    rule,
  };
}

/** Premium theta would take over the planned hold, as a percent of the ask. Today's per-day rate spread evenly over calendar time. */
export function thetaOverHoldPercent(cost: ContractCost | null, holdMinutes: number | null): number | null {
  if (cost === null || cost.thetaLossPercentOfAsk === null || !positive(holdMinutes)) return null;
  return (cost.thetaLossPercentOfAsk * holdMinutes) / (24 * 60);
}

function timeCheck(cost: ContractCost | null, plan: PlanInput): CheckResult {
  const d = CHECKLIST_RULES.daysToExpiry;
  const t = CHECKLIST_RULES.thetaOverHoldPercentOfAsk;
  const rule = `Worse of two: days to expiry (fail under ${d.fail}, caution under ${d.caution}) and, once you have entered how long you will hold, the premium theta would take over that time as a share of the ask (caution above ${t.caution}%, fail above ${t.fail}%). Theta is today's per-day rate spread evenly over calendar time, which understates the decay near expiry and near the close.`;
  if (cost === null || cost.daysToExpiry === null) return { id: "time", title: "Time left", status: "unknown", value: "–", detail: "No days to expiry for this contract.", rule };
  const byDays = cost.daysToExpiry < d.fail ? "fail" : cost.daysToExpiry < d.caution ? "caution" : "pass";
  const held = thetaOverHoldPercent(cost, plan.holdMinutes);
  const byTheta = held === null ? "pass" : held > t.fail ? "fail" : held > t.caution ? "caution" : "pass";
  const status = worst(byDays, byTheta);
  const perDay = cost.thetaLossPercentOfAsk === null ? "no theta (IV not solved)" : `theta ${pct(cost.thetaLossPercentOfAsk, 1)} of the ask a day`;
  const heldText = held === null ? (cost.thetaLossPercentOfAsk === null ? "" : " · enter a hold time to see what waiting costs") : ` · about ${pct(held, 1)} over your ${plan.holdMinutes} min hold`;
  return {
    id: "time",
    title: "Time left",
    status,
    value: `${cost.daysToExpiry.toFixed(1)} days · ${perDay}${heldText}`,
    detail: status === "pass" ? "Time decay over your planned hold is a small part of the premium." : "A slow market costs more here: the premium decays whether or not the index moves.",
    rule,
  };
}

function ivCheck(cost: ContractCost | null): CheckResult {
  return {
    id: "iv",
    title: "Implied volatility",
    status: "not-scored",
    value: cost?.impliedVolatility != null ? `IV ${pct(cost.impliedVolatility * 100, 2)}` : "–",
    detail: "Not scored: no IV history is stored to say whether this is high or low for the contract. Compare it with its own recent range, and with India VIX, before buying; paying a high IV means the premium can fall even if the index goes your way.",
    rule: "Not scored. A score needs a stored IV history; none exists for the chain yet.",
  };
}

function levelsCheck(input: ChecklistInput): CheckResult {
  const rule = "Compares the nearest big open-interest wall on the side your option needs (call OI above the index for a call, put OI below it for a put) with the index move your target needs, worked first-order as the premium gain over the delta. Caution if the wall comes before the target. A wall is a place sellers are positioned, not a barrier.";
  const { side, cost, walls, plan, spot } = input;
  const wall = walls === null ? null : side === "CE" ? walls.callWall : walls.putWall;
  const title = "Levels and open-interest walls";
  if (wall === null || spot === null) {
    return { id: "levels", title, status: "unknown", value: "–", detail: "No open-interest wall found on that side in the strikes loaded.", rule };
  }
  const distance = Math.abs(wall.strike - spot);
  const wallText = `${side === "CE" ? "call" : "put"} OI wall at ${wall.strike.toLocaleString("en-IN")} (${side === "CE" ? "+" : "−"}${Math.round(distance).toLocaleString("en-IN")} pts)`;
  const ask = cost?.quote?.ask ?? null;
  const delta = cost?.delta != null ? Math.abs(cost.delta) : null;
  if (!positive(ask) || !positive(plan.targetPremium) || plan.targetPremium <= ask || !positive(delta) || delta < 0.05) {
    return { id: "levels", title, status: "unknown", value: wallText, detail: "Set a target above the ask (and the contract needs a delta) to compare it with this wall.", rule };
  }
  const needed = (plan.targetPremium - ask) / delta;
  const status = distance < needed ? "caution" : "pass";
  return {
    id: "levels",
    title,
    status,
    value: `${wallText}; target needs about ${side === "CE" ? "+" : "−"}${Math.round(needed).toLocaleString("en-IN")} pts`,
    detail: status === "caution" ? "The wall is nearer than the move your target needs, so the index would have to move through it." : "The wall is beyond the move your target needs, on a first-order estimate that ignores gamma, theta and IV changes.",
    rule,
  };
}

function exitPlanCheck(plan: PlanInput, ask: number | null, sizing: Sizing | null): CheckResult {
  const rule = `Pass if you have written a stop below the ask, a target above it, a time limit, and a reason of at least ${CHECKLIST_RULES.minReasonLength} characters (why the index should move, by about how much, by when), and the reward over risk after charges is at least ${CHECKLIST_RULES.minNetRewardToRisk}; caution if it is below that. The text is not judged, only that you wrote it.`;
  const title = "Exit plan written";
  const missing: string[] = [];
  if (!positive(plan.stopPremium)) missing.push("stop");
  if (!positive(plan.targetPremium)) missing.push("target");
  if (!positive(plan.holdMinutes)) missing.push("time limit");
  if (plan.reason.trim().length < CHECKLIST_RULES.minReasonLength) missing.push("reason");
  if (missing.length > 0) return { id: "exit-plan", title, status: "fail", value: `missing: ${missing.join(", ")}`, detail: "Decide the exit before you enter; deciding it under stress is how stops get moved.", rule };
  if (!positive(ask)) return { id: "exit-plan", title, status: "unknown", value: "–", detail: "No ask to measure the stop and target from.", rule };
  if (plan.stopPremium! >= ask) return { id: "exit-plan", title, status: "fail", value: `stop ${two(plan.stopPremium!)} is not below the ask ${two(ask)}`, detail: "A stop at or above the price you pay closes at once.", rule };
  if (plan.targetPremium! <= ask) return { id: "exit-plan", title, status: "fail", value: `target ${two(plan.targetPremium!)} is not above the ask ${two(ask)}`, detail: "A target at or below the price you pay is not a target.", rule };
  const rr = sizing?.netRewardToRisk ?? null;
  if (rr === null) return { id: "exit-plan", title, status: "unknown", value: "plan written", detail: "The reward-to-risk after charges needs the lot size and charges from the API.", rule };
  const status = rr >= CHECKLIST_RULES.minNetRewardToRisk ? "pass" : "caution";
  return {
    id: "exit-plan",
    title,
    status,
    value: `stop ${two(plan.stopPremium!)} · target ${two(plan.targetPremium!)} · out after ${plan.holdMinutes} min · ${rr.toFixed(2)}× reward to risk after charges`,
    detail: status === "pass" ? "A written plan with a reward at least as large as the risk." : "The reward after charges is smaller than the risk at the stop: you need to be right more often than you are wrong just to break even.",
    rule,
  };
}

/**
 * A typical move of the index over the planned hold, in points: the middle of the expected absolute daily band, scaled by the square
 * root of the share of the trading day held (moves grow with the square root of time). A holding period past one session is capped at
 * one day: overnight and multi-day holds are not described by this scaling.
 */
export function typicalHoldMovePoints(typicalDay: { low: number; high: number } | null, holdMinutes: number | null): number | null {
  if (typicalDay === null || !positive(holdMinutes) || !(typicalDay.low > 0) || !(typicalDay.high >= typicalDay.low)) return null;
  const share = Math.min(1, holdMinutes / CHECKLIST_RULES.tradingMinutesPerDay);
  return ((typicalDay.low + typicalDay.high) / 2) * Math.sqrt(share);
}

function stopNoiseCheck(input: ChecklistInput, ask: number | null): CheckResult {
  const r = CHECKLIST_RULES.stopOverTypicalMove;
  const rule = `Pass if your stop is at least ${r.pass}× a typical index move over your hold, caution from ${r.caution}× up to that, fail below. The stop is turned into index points first-order (the premium you risk over the delta); a typical move is the middle of the expected daily band scaled by the square root of the share of the trading day you hold. A stop inside normal movement is hit by ordinary noise rather than by being wrong.`;
  const title = "Stop outside normal noise";
  const { cost, plan, typicalDay } = input;
  const delta = cost?.delta != null ? Math.abs(cost.delta) : null;
  const typical = typicalHoldMovePoints(typicalDay, plan.holdMinutes);
  if (!positive(ask) || !positive(plan.stopPremium) || plan.stopPremium >= ask || !positive(delta) || delta < 0.05 || typical === null) {
    return { id: "stop-noise", title, status: "unknown", value: "–", detail: "Needs a stop below the ask, a hold time, a delta, and the implied daily move.", rule };
  }
  const stopPoints = (ask - plan.stopPremium) / delta;
  const ratio = stopPoints / typical;
  const status = ratio >= r.pass ? "pass" : ratio >= r.caution ? "caution" : "fail";
  return {
    id: "stop-noise",
    title,
    status,
    value: `stop is about ${Math.round(stopPoints).toLocaleString("en-IN")} index points away; a typical move over ${plan.holdMinutes} min is about ${Math.round(typical).toLocaleString("en-IN")} (${ratio.toFixed(2)}×)`,
    detail: status === "pass" ? "The stop sits outside normal movement over your hold." : "The stop is inside the range the index routinely moves in your holding time, so it is likely to be hit by noise.",
    rule,
  };
}

function sizeCheck(plan: PlanInput, sizing: Sizing | null): CheckResult {
  const rule = "Lots are the most you can buy so that the loss at your stop, charges included, stays within the amount you said you would lose. Fails if that amount does not cover even one lot at this stop.";
  const title = "Position size";
  if (!positive(plan.riskBudgetInr)) return { id: "size", title, status: "unknown", value: "–", detail: "Enter the most you are willing to lose on this trade, in rupees.", rule };
  if (sizing === null || sizing.lots === null) return { id: "size", title, status: "unknown", value: "–", detail: "Needs a stop below the ask, a two-sided quote, and the lot size from the API.", rule };
  if (sizing.lots < 1) {
    return { id: "size", title, status: "fail", value: `0 lots: one lot loses ${inr(sizing.lossAtStop)} at the stop`, detail: `That is more than your ${inr(plan.riskBudgetInr)} limit. Widen the limit, move the stop closer, or choose a cheaper contract.`, rule };
  }
  return {
    id: "size",
    title,
    status: "pass",
    value: `${sizing.lots} lot${sizing.lots === 1 ? "" : "s"} (${sizing.quantity.toLocaleString("en-IN")} units) · pays ${inr(sizing.premiumPaid)} · loses ${inr(sizing.lossAtStop)} at the stop`,
    detail: `Within your ${inr(plan.riskBudgetInr)} limit (${pct((sizing.lossAtStop / plan.riskBudgetInr) * 100, 0)} of it).`,
    rule,
  };
}

export interface ChecklistSummary {
  pass: number;
  caution: number;
  fail: number;
  unknown: number;
  notScored: number;
  /** One sentence. Never says to trade or not to trade. */
  sentence: string;
}

export interface Checklist {
  checks: CheckResult[];
  sizing: Sizing | null;
  summary: ChecklistSummary;
}

export function buildChecklist(input: ChecklistInput): Checklist {
  const ask = input.cost?.quote?.ask ?? null;
  const sizing = buildSizing(ask, input.plan, input.fees);
  const checks: CheckResult[] = [
    chargesCheck(sizing),
    spreadCheck(input.cost, input.quoteWarning),
    timeCheck(input.cost, input.plan),
    ivCheck(input.cost),
    levelsCheck(input),
    exitPlanCheck(input.plan, ask, sizing),
    stopNoiseCheck(input, ask),
    sizeCheck(input.plan, sizing),
  ];
  const count = (status: CheckStatus) => checks.filter((check) => check.status === status).length;
  const summary: ChecklistSummary = {
    pass: count("pass"),
    caution: count("caution"),
    fail: count("fail"),
    unknown: count("unknown"),
    notScored: count("not-scored"),
    sentence: "",
  };
  const scored = summary.pass + summary.caution + summary.fail + summary.unknown;
  const parts = [`${summary.pass} of ${scored} checks pass`];
  if (summary.caution > 0) parts.push(`${summary.caution} caution`);
  if (summary.fail > 0) parts.push(`${summary.fail} fail`);
  if (summary.unknown > 0) parts.push(`${summary.unknown} unknown`);
  summary.sentence = `${parts.join(", ")}${summary.notScored > 0 ? ` (${summary.notScored} not scored)` : ""}. Passing every check does not say the trade will win, and failing one does not say it will lose: the decision is yours.`;
  return { checks, sizing, summary };
}
