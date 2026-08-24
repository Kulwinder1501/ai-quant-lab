import { calculateTotalFees } from "../../../paper-trading/domain/brokerage-calculator.js";
import { OPTION_TICK_SIZE } from "../../../pricing/domain/option-tick.js";
import {
  summariseExpectancy,
  type DailyExpectancy,
  type ExpectancySummary,
} from "../../../backtesting/domain/expectancy-statistics.js";

/** Frozen execution policy for the sole Phase 29 D2 candidate. */
export const D2_HORIZON_MINUTES = 30;
export const D2_SIGNAL_TAIL_FRACTION = 0.10;
export const D2_MINIMUM_PREMIUM_SESSIONS = 60;
export const D2_MINIMUM_RESOLVED_TRADES = 30;
export const D2_MAX_QUOTE_LAG_MS = 60_000;
export const D2_PRIMARY_ADVERSE_TICKS = 1;
export const D2_MULTIPLICITY_TRIALS = 24;

export interface D2Signal {
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly dataThrough: Date;
  readonly score: number;
  readonly side: "UP" | "DOWN";
  readonly underlyingReferencePrice: number;
}

export interface D2PremiumTick {
  readonly underlyingSymbol: string;
  readonly observedAt: Date;
  readonly expiryDate: string;
  readonly strikePrice: number;
  readonly optionType: "CE" | "PE";
  readonly providerSymbol: string;
  readonly bid: number | null;
  readonly ask: number | null;
  readonly underlyingValue: number | null;
}

export interface D2ExecutionScenario {
  readonly name: "observed-book" | "primary-one-tick" | "stress-two-ticks";
  readonly extraAdverseTicksPerLeg: 0 | 1 | 2;
}

export const D2_EXECUTION_SCENARIOS: readonly D2ExecutionScenario[] = [
  { name: "observed-book", extraAdverseTicksPerLeg: 0 },
  { name: "primary-one-tick", extraAdverseTicksPerLeg: 1 },
  { name: "stress-two-ticks", extraAdverseTicksPerLeg: 2 },
] as const;

export interface D2ResolvedQuotePair {
  readonly sessionDate: string;
  readonly decisionAt: Date;
  readonly scheduledExitAt: Date;
  readonly entryObservedAt: Date;
  readonly exitObservedAt: Date;
  readonly side: "UP" | "DOWN";
  readonly score: number;
  readonly optionType: "CE" | "PE";
  readonly expiryDate: string;
  readonly strikePrice: number;
  readonly providerSymbol: string;
  readonly entryAsk: number;
  readonly exitBid: number;
  readonly quantity: number;
}

export interface D2CostedTrade extends D2ResolvedQuotePair {
  readonly scenario: D2ExecutionScenario["name"];
  readonly entryFill: number;
  readonly exitFill: number;
  readonly grossPnl: number;
  readonly fees: number;
  readonly netPnl: number;
  /** Net return on premium paid, used as the comparable per-trade return unit. */
  readonly netReturn: number;
}

export interface D2DeflatedSharpe {
  readonly observations: number;
  readonly selectionTrials: number;
  readonly observedSharpe: number;
  readonly expectedMaximumNullSharpe: number;
  readonly probabilitySharpeExceedsSelectionBias: number;
}

export interface D2ScenarioSummary {
  readonly scenario: D2ExecutionScenario;
  readonly trades: readonly D2CostedTrade[];
  readonly daily: readonly DailyExpectancy[];
  readonly expectancy: ExpectancySummary;
  readonly grossPnl: number;
  readonly fees: number;
  readonly netPnl: number;
  readonly winRate: number;
  readonly profitFactor: number | null;
  readonly deflatedSharpe: D2DeflatedSharpe | null;
}

export interface D2SkipCounts {
  readonly overlappingPosition: number;
  readonly missingEntryQuote: number;
  readonly missingExitQuote: number;
}

export type D2InstrumentVerdict = "PASS" | "FAIL" | "INSUFFICIENT_DATA";

/**
 * Per-session coverage of the frozen opportunity set, for the §8.3 qualification rule.
 *
 * Purely observational: it counts what the unchanged resolution loop already decided, and feeds no
 * threshold, selection or execution rule here. It exists because §4.1's "a day counts only when both
 * index features and executable premium quotes pass audit" was never implemented, and because the
 * aggregate `D2SkipCounts` cannot answer it -- qualification is per session, and totals across
 * sessions cannot be un-summed.
 *
 * `overlappingPosition` is deliberately **not** a coverage failure. The no-overlap rule declines
 * those signals as policy; their outcomes are not unobserved, they were never opened. Counting them
 * would fail sessions for behaving exactly as the protocol specifies.
 */
export interface D2SessionCoverage {
  readonly sessionDate: string;
  /** Signals the policy actually attempted to open, i.e. excluding overlap declines. */
  readonly attempted: number;
  readonly resolved: number;
  readonly missingEntryQuote: number;
  readonly missingExitQuote: number;
  readonly status: "QUALIFIED" | "UNCOVERED" | "NOT_TESTABLE_NO_OPPORTUNITIES";
}

export interface D2PremiumCostGateResult {
  readonly underlyingSymbol: string;
  readonly premiumSessionDates: readonly string[];
  readonly signalCount: number;
  readonly resolvedQuotePairCount: number;
  readonly skips: D2SkipCounts;
  /** One row per stored premium session, ordered by date. See `D2SessionCoverage`. */
  readonly sessionCoverage: readonly D2SessionCoverage[];
  readonly qualifiedSessionCount: number;
  readonly scenarios: readonly D2ScenarioSummary[];
  readonly primaryScenario: D2ExecutionScenario["name"];
  readonly verdict: D2InstrumentVerdict;
  readonly verdictReasons: readonly string[];
  readonly pbo: null;
  readonly pboUnavailableReason: string;
}

export interface D2PremiumCostGateInput {
  readonly underlyingSymbol: string;
  readonly signals: readonly D2Signal[];
  readonly ticks: readonly D2PremiumTick[];
  readonly quantity: number;
  readonly premiumSessionDates?: readonly string[];
}

function round(value: number): number {
  return Number(value.toFixed(8));
}

function isPositiveQuote(value: number | null): value is number {
  return value !== null && Number.isFinite(value) && value > 0;
}

function lowerBoundByTime(ticks: readonly D2PremiumTick[], targetMs: number): number {
  let low = 0;
  let high = ticks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (ticks[middle]!.observedAt.getTime() < targetMs) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Exported so the D2 opportunity-coverage audit can check premium availability with the exact
 * frozen contract-selection rule instead of a reimplementation that could silently drift from it.
 * Adding this export changes no computation in this file.
 */
export function chooseEntryTick(
  ticks: readonly D2PremiumTick[],
  signal: D2Signal,
): D2PremiumTick | null {
  const wantedType = signal.side === "UP" ? "CE" : "PE";
  const startMs = signal.decisionAt.getTime();
  const endMs = startMs + D2_MAX_QUOTE_LAG_MS;
  let index = lowerBoundByTime(ticks, startMs);

  while (index < ticks.length) {
    const observedMs = ticks[index]!.observedAt.getTime();
    if (observedMs > endMs) break;
    const coherent: D2PremiumTick[] = [];
    while (index < ticks.length && ticks[index]!.observedAt.getTime() === observedMs) {
      const tick = ticks[index]!;
      if (
        tick.optionType === wantedType
        && tick.expiryDate >= signal.sessionDate
        && isPositiveQuote(tick.ask)
        && isPositiveQuote(tick.bid)
      ) coherent.push(tick);
      index += 1;
    }
    if (coherent.length === 0) continue;

    coherent.sort((left, right) => {
      const expiryOrder = left.expiryDate.localeCompare(right.expiryDate);
      if (expiryOrder !== 0) return expiryOrder;
      const leftSpot = left.underlyingValue ?? signal.underlyingReferencePrice;
      const rightSpot = right.underlyingValue ?? signal.underlyingReferencePrice;
      const distance = Math.abs(left.strikePrice - leftSpot) - Math.abs(right.strikePrice - rightSpot);
      if (distance !== 0) return distance;
      const spread = (left.ask! - left.bid!) - (right.ask! - right.bid!);
      return spread || left.providerSymbol.localeCompare(right.providerSymbol);
    });
    return coherent[0]!;
  }
  return null;
}

/** Exported for the same reason as {@link chooseEntryTick}; behaviour is unchanged. */
export function chooseExitTick(
  contractTicks: readonly D2PremiumTick[],
  scheduledExitAt: Date,
): D2PremiumTick | null {
  const startMs = scheduledExitAt.getTime();
  const endMs = startMs + D2_MAX_QUOTE_LAG_MS;
  let index = lowerBoundByTime(contractTicks, startMs);
  while (index < contractTicks.length) {
    const tick = contractTicks[index]!;
    if (tick.observedAt.getTime() > endMs) break;
    if (isPositiveQuote(tick.bid)) return tick;
    index += 1;
  }
  return null;
}

function costQuotePair(pair: D2ResolvedQuotePair, scenario: D2ExecutionScenario): D2CostedTrade {
  const adverseMove = scenario.extraAdverseTicksPerLeg * OPTION_TICK_SIZE;
  const entryFill = pair.entryAsk + adverseMove;
  const exitFill = Math.max(0, pair.exitBid - adverseMove);
  const grossPnl = (exitFill - entryFill) * pair.quantity;
  const fees = calculateTotalFees(entryFill, exitFill, pair.quantity).total;
  const netPnl = grossPnl - fees;
  const premiumPaid = entryFill * pair.quantity;
  return {
    ...pair,
    scenario: scenario.name,
    entryFill: round(entryFill),
    exitFill: round(exitFill),
    grossPnl: round(grossPnl),
    fees: round(fees),
    netPnl: round(netPnl),
    netReturn: round(premiumPaid > 0 ? netPnl / premiumPaid : 0),
  };
}

function normalCdf(value: number): number {
  const sign = value < 0 ? -1 : 1;
  const x = Math.abs(value) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const coefficients = [0.254829592, -0.284496736, 1.421413741, -1.453152027, 1.061405429];
  const erf = sign * (1 - (((((coefficients[4]! * t + coefficients[3]!) * t)
    + coefficients[2]!) * t + coefficients[1]!) * t + coefficients[0]!) * t * Math.exp(-x * x));
  return Math.max(0, Math.min(1, 0.5 * (1 + erf)));
}

/** Acklam's inverse-normal approximation, sufficient for the DSR selection benchmark. */
function inverseNormalCdf(probability: number): number {
  if (!(probability > 0 && probability < 1)) throw new Error("probability must be between zero and one.");
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
      / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (probability <= high) {
    const q = probability - 0.5;
    const r = q * q;
    return (((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q
      / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
  }
  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!)
    / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
}

export function calculateDeflatedSharpe(
  dailyReturns: readonly number[],
  selectionTrials = D2_MULTIPLICITY_TRIALS,
): D2DeflatedSharpe | null {
  if (dailyReturns.length < 3 || selectionTrials < 1) return null;
  const count = dailyReturns.length;
  const mean = dailyReturns.reduce((sum, value) => sum + value, 0) / count;
  const variance = dailyReturns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const standardDeviation = Math.sqrt(variance);
  if (!(standardDeviation > 0)) return null;
  const sharpe = mean / standardDeviation;
  const skew = dailyReturns.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 3, 0) / count;
  const kurtosis = dailyReturns.reduce((sum, value) => sum + ((value - mean) / standardDeviation) ** 4, 0) / count;
  const expectedMaximumNullSharpe = inverseNormalCdf((selectionTrials - 0.375) / (selectionTrials + 0.25))
    / Math.sqrt(count - 1);
  const denominatorSquared = 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe;
  const testStatistic = denominatorSquared > 0
    ? (sharpe - expectedMaximumNullSharpe) * Math.sqrt(count - 1) / Math.sqrt(denominatorSquared)
    : Number.NEGATIVE_INFINITY;
  return {
    observations: count,
    selectionTrials,
    observedSharpe: round(sharpe),
    expectedMaximumNullSharpe: round(expectedMaximumNullSharpe),
    probabilitySharpeExceedsSelectionBias: round(normalCdf(testStatistic)),
  };
}

function summariseScenario(
  pairs: readonly D2ResolvedQuotePair[],
  scenario: D2ExecutionScenario,
  premiumSessionDates: readonly string[],
): D2ScenarioSummary {
  const trades = pairs.map((pair) => costQuotePair(pair, scenario));
  const returnsByDay = new Map<string, number[]>();
  for (const trade of trades) {
    const values = returnsByDay.get(trade.sessionDate) ?? [];
    values.push(trade.netReturn);
    returnsByDay.set(trade.sessionDate, values);
  }
  const daily: DailyExpectancy[] = premiumSessionDates.map((day) => {
    const values = returnsByDay.get(day) ?? [];
    return {
      day,
      meanNetR: values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length,
      trades: values.length,
    };
  });
  const grossProfit = trades.reduce((sum, trade) => sum + Math.max(0, trade.netPnl), 0);
  const grossLoss = trades.reduce((sum, trade) => sum + Math.max(0, -trade.netPnl), 0);
  return {
    scenario,
    trades,
    daily,
    expectancy: summariseExpectancy(daily),
    grossPnl: round(trades.reduce((sum, trade) => sum + trade.grossPnl, 0)),
    fees: round(trades.reduce((sum, trade) => sum + trade.fees, 0)),
    netPnl: round(trades.reduce((sum, trade) => sum + trade.netPnl, 0)),
    winRate: round(trades.length === 0 ? 0 : trades.filter((trade) => trade.netPnl > 0).length / trades.length),
    profitFactor: grossLoss === 0 ? null : round(grossProfit / grossLoss),
    deflatedSharpe: calculateDeflatedSharpe(daily.map((entry) => entry.meanNetR)),
  };
}

export function evaluateD2PremiumCostGate(input: D2PremiumCostGateInput): D2PremiumCostGateResult {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) {
    throw new Error("D2 quantity must be one positive whole-number lot.");
  }
  const ticks = input.ticks
    .filter((tick) => tick.underlyingSymbol === input.underlyingSymbol)
    .sort((left, right) => left.observedAt.getTime() - right.observedAt.getTime());
  const premiumSessionDates = [...new Set(input.premiumSessionDates ?? input.signals.map((signal) => signal.sessionDate))].sort();
  const signals = [...input.signals].sort((left, right) => left.decisionAt.getTime() - right.decisionAt.getTime());
  const contractTicks = new Map<string, D2PremiumTick[]>();
  for (const tick of ticks) {
    const values = contractTicks.get(tick.providerSymbol) ?? [];
    values.push(tick);
    contractTicks.set(tick.providerSymbol, values);
  }

  const pairs: D2ResolvedQuotePair[] = [];
  let blockedUntilMs = Number.NEGATIVE_INFINITY;
  let overlappingPosition = 0;
  let missingEntryQuote = 0;
  let missingExitQuote = 0;

  // Seeded from the stored session list, not from the signals, so a session that produced no
  // opportunity still gets a row. Otherwise it would silently vanish from the qualification
  // denominator instead of being recorded as untestable.
  const coverage = new Map<string, { attempted: number; resolved: number; missingEntry: number; missingExit: number }>(
    premiumSessionDates.map((sessionDate) => [sessionDate, { attempted: 0, resolved: 0, missingEntry: 0, missingExit: 0 }]),
  );
  const coverageFor = (sessionDate: string) => {
    const existing = coverage.get(sessionDate);
    if (existing) return existing;
    const created = { attempted: 0, resolved: 0, missingEntry: 0, missingExit: 0 };
    coverage.set(sessionDate, created);
    return created;
  };

  for (const signal of signals) {
    if (signal.dataThrough.getTime() >= signal.decisionAt.getTime()) {
      throw new Error("D2 feature dataThrough must be strictly earlier than decisionAt.");
    }
    if (signal.decisionAt.getTime() < blockedUntilMs) {
      overlappingPosition += 1;
      continue;
    }
    const sessionCoverage = coverageFor(signal.sessionDate);
    sessionCoverage.attempted += 1;
    const entry = chooseEntryTick(ticks, signal);
    if (!entry) {
      missingEntryQuote += 1;
      sessionCoverage.missingEntry += 1;
      continue;
    }
    const scheduledExitAt = new Date(signal.decisionAt.getTime() + D2_HORIZON_MINUTES * 60_000);
    blockedUntilMs = scheduledExitAt.getTime();
    const exit = chooseExitTick(contractTicks.get(entry.providerSymbol) ?? [], scheduledExitAt);
    if (!exit) {
      missingExitQuote += 1;
      sessionCoverage.missingExit += 1;
      continue;
    }
    blockedUntilMs = exit.observedAt.getTime();
    sessionCoverage.resolved += 1;
    pairs.push({
      sessionDate: signal.sessionDate,
      decisionAt: signal.decisionAt,
      scheduledExitAt,
      entryObservedAt: entry.observedAt,
      exitObservedAt: exit.observedAt,
      side: signal.side,
      score: signal.score,
      optionType: entry.optionType,
      expiryDate: entry.expiryDate,
      strikePrice: entry.strikePrice,
      providerSymbol: entry.providerSymbol,
      entryAsk: entry.ask!,
      exitBid: exit.bid!,
      quantity: input.quantity,
    });
  }

  const sessionCoverage: D2SessionCoverage[] = [...coverage.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([sessionDate, counts]) => ({
      sessionDate,
      attempted: counts.attempted,
      resolved: counts.resolved,
      missingEntryQuote: counts.missingEntry,
      missingExitQuote: counts.missingExit,
      // A session with nothing attempted is untestable rather than qualified: there is no outcome
      // to have observed, so admitting it toward the 60 would pad the denominator with days the
      // experiment never tested.
      status: counts.attempted === 0
        ? "NOT_TESTABLE_NO_OPPORTUNITIES"
        : counts.resolved === counts.attempted ? "QUALIFIED" : "UNCOVERED",
    }));
  const qualifiedSessionCount = sessionCoverage.filter((session) => session.status === "QUALIFIED").length;

  const scenarios = D2_EXECUTION_SCENARIOS.map((scenario) => (
    summariseScenario(pairs, scenario, premiumSessionDates)
  ));
  const primary = scenarios.find((summary) => (
    summary.scenario.extraAdverseTicksPerLeg === D2_PRIMARY_ADVERSE_TICKS
  ))!;
  const verdictReasons: string[] = [];
  let verdict: D2InstrumentVerdict;
  if (premiumSessionDates.length < D2_MINIMUM_PREMIUM_SESSIONS) {
    verdictReasons.push(
      `Only ${premiumSessionDates.length} premium sessions are stored; ${D2_MINIMUM_PREMIUM_SESSIONS} are required.`,
    );
  }
  if (pairs.length < D2_MINIMUM_RESOLVED_TRADES) {
    verdictReasons.push(`Only ${pairs.length} trades resolved; ${D2_MINIMUM_RESOLVED_TRADES} are required.`);
  }
  if (verdictReasons.length > 0) {
    verdict = "INSUFFICIENT_DATA";
  } else {
    const ci = primary.expectancy.ci95;
    const clearsGate = primary.expectancy.meanDailyR >= 0 && ci !== null && ci[0] > 0;
    verdict = clearsGate ? "PASS" : "FAIL";
    if (!clearsGate) {
      verdictReasons.push("Primary one-tick net expectancy is negative or its day-level 95% CI does not exclude zero.");
    }
  }

  return {
    underlyingSymbol: input.underlyingSymbol,
    premiumSessionDates,
    signalCount: signals.length,
    resolvedQuotePairCount: pairs.length,
    skips: { overlappingPosition, missingEntryQuote, missingExitQuote },
    sessionCoverage,
    qualifiedSessionCount,
    scenarios,
    primaryScenario: primary.scenario.name,
    verdict,
    verdictReasons,
    pbo: null,
    pboUnavailableReason: "PBO/CSCV needs at least two fully costed strategy return series; Holm advanced only one D2 candidate.",
  };
}
