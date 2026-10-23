import type { OptionType } from "./option-chain.js";

/**
 * Open interest over one trading session, rebuilt from stored chain snapshots.
 *
 * Pure: it takes rows already read from `option_chain_snapshots` and returns the series a chart draws.
 * Four properties of the data shape every rule below, each measured on the stored series rather than
 * assumed.
 *
 * 1. **The pre-open slot is carryover, not an observation.** At 09:11 IST `open_interest` equals
 *    `previous_open_interest` on 100% of NIFTY50 and BANKNIFTY rows (30 days). Plotting it would draw a
 *    fake flat first point with a change of zero, so it is reported separately and never enters a series.
 * 2. **The stored strike window slides with ATM.** Each snapshot holds 31 strikes around the spot *at
 *    that moment*; over one session ~38 strikes appear but only ~24 are in every snapshot. Summing "all
 *    strikes in each snapshot" would therefore turn the window moving into an OI change. Aggregates use a
 *    fixed strike set: strikes present on both sides, with OI, in every intraday snapshot.
 * 3. **`previous_open_interest` is the previous session's close**, constant within a day (1,102 of 1,102
 *    contract-days). It is the baseline for "change vs previous close", and it is not an intraday
 *    quantity. "Change vs previous snapshot" is a different number and is named differently throughout.
 * 4. **Collection is irregular.** The cron runs at minutes 11/23/41/53 (gaps of 12 or 18 minutes) and
 *    single runs are sometimes missed (30-minute gaps seen). A gap is reported, never interpolated.
 *
 * Units are the provider's `oi`: underlying units, not lots. A missing contract or a null OI stays
 * null; it is never coerced to zero.
 */

/** Snapshots observed strictly before 09:15 IST carry the previous close, not a fresh book. */
export const OI_PRE_OPEN_CUTOFF_MINUTE_OF_DAY_IST = 9 * 60 + 15;

/** Largest cron gap is 18 minutes; anything past this means at least one scheduled run was missed. */
export const OI_COLLECTION_GAP_AFTER_MINUTES = 20;

export const MAX_OI_HISTORY_CONTRACTS = 8;

export const OI_UNIT_LABEL = "units (Fyers oi; not lots)";

export interface OiHistoryRow {
  observedAt: Date;
  strikePrice: number;
  optionType: OptionType;
  openInterest: number | null;
  previousOpenInterest: number | null;
  underlyingValue: number | null;
}

export interface ContractRef {
  strikePrice: number;
  optionType: OptionType;
}

export type OiObservationKind = "PRE_OPEN_CARRYOVER" | "INTRADAY";

export interface OiHistoryObservation {
  /** ISO-8601 UTC instant the snapshot was received. */
  observedAt: string;
  kind: OiObservationKind;
  underlyingValue: number | null;
  contractsObserved: number;
}

export interface OiHistoryPoint {
  /** Whether the contract was in this snapshot's strike window at all. */
  present: boolean;
  openInterest: number | null;
  /** OI minus the previous session's close OI. Null when either side is unknown. */
  changeVsPreviousClose: number | null;
  /** OI minus the immediately preceding snapshot's OI. Null when that snapshot lacks the contract. */
  changeVsPreviousSnapshot: number | null;
}

export interface OiHistoryContractSeries {
  strikePrice: number;
  optionType: OptionType;
  /** The exchange's previous-session OI for this contract, or null when never reported. */
  previousCloseOpenInterest: number | null;
  /** False if `previous_open_interest` changed within the session, which it should never do. */
  baselineConsistent: boolean;
  /** Aligned one-to-one with `observations`. */
  points: OiHistoryPoint[];
}

export interface OiHistoryTotalsPoint {
  calls: number;
  puts: number;
  /** puts / calls, or null when calls is zero. */
  putCallRatio: number | null;
  callsChangeVsPreviousClose: number;
  putsChangeVsPreviousClose: number;
}

export interface OiHistoryTotals {
  /** Human-readable statement of how the strike set was chosen. */
  rule: string;
  strikesUsed: number[];
  /** Strikes seen in the session that were left out because they were not in every snapshot. */
  strikesExcluded: number;
  previousCloseCalls: number;
  previousClosePuts: number;
  /** Aligned one-to-one with `observations`. */
  points: OiHistoryTotalsPoint[];
}

export interface OiCollectionGap {
  from: string;
  to: string;
  minutes: number;
}

export interface OiHistoryResult {
  /** The carryover snapshot, if the session has one. Not part of any series. */
  preOpen: OiHistoryObservation | null;
  /** Intraday snapshots in time order; every series aligns to this list. */
  observations: OiHistoryObservation[];
  collectionGaps: OiCollectionGap[];
  contracts: OiHistoryContractSeries[];
  /** Null, with the reason, when no strike survives the fixed-set rule. */
  totals: OiHistoryTotals | { unavailable: string } | null;
  /** Strikes present in the last intraday snapshot, for a selector. */
  selectableStrikes: number[];
}

const MS_PER_MINUTE = 60_000;
const MS_PER_DAY = 24 * 60 * MS_PER_MINUTE;
const IST_OFFSET_MS = 330 * MS_PER_MINUTE;

/** Minutes since IST midnight. India has no daylight saving, so a fixed offset is exact. */
export function istMinuteOfDay(instant: Date): number {
  const shifted = instant.getTime() + IST_OFFSET_MS;
  return Math.floor((((shifted % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_MINUTE);
}

export function observationKindOf(instant: Date): OiObservationKind {
  return istMinuteOfDay(instant) < OI_PRE_OPEN_CUTOFF_MINUTE_OF_DAY_IST ? "PRE_OPEN_CARRYOVER" : "INTRADAY";
}

function contractKey(strikePrice: number, optionType: OptionType): string {
  return `${strikePrice}|${optionType}`;
}

interface ObservationGroup {
  observedAt: Date;
  kind: OiObservationKind;
  rows: Map<string, OiHistoryRow>;
  underlyingValue: number | null;
}

function groupByObservation(rows: readonly OiHistoryRow[]): ObservationGroup[] {
  const byInstant = new Map<number, ObservationGroup>();
  for (const row of rows) {
    const key = row.observedAt.getTime();
    let group = byInstant.get(key);
    if (!group) {
      group = {
        observedAt: row.observedAt,
        kind: observationKindOf(row.observedAt),
        rows: new Map(),
        underlyingValue: null,
      };
      byInstant.set(key, group);
    }
    group.rows.set(contractKey(row.strikePrice, row.optionType), row);
    if (group.underlyingValue === null && row.underlyingValue !== null) group.underlyingValue = row.underlyingValue;
  }
  return [...byInstant.values()].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
}

function toObservation(group: ObservationGroup): OiHistoryObservation {
  return {
    observedAt: group.observedAt.toISOString(),
    kind: group.kind,
    underlyingValue: group.underlyingValue,
    contractsObserved: group.rows.size,
  };
}

/** The first reported previous-close OI for a contract, and whether every report agreed. */
function baselineFor(intraday: readonly ObservationGroup[], key: string): { value: number | null; consistent: boolean } {
  let value: number | null = null;
  let consistent = true;
  for (const group of intraday) {
    const previous = group.rows.get(key)?.previousOpenInterest ?? null;
    if (previous === null) continue;
    if (value === null) value = previous;
    else if (previous !== value) consistent = false;
  }
  return { value, consistent };
}

function buildContractSeries(
  intraday: readonly ObservationGroup[],
  contract: ContractRef,
): OiHistoryContractSeries {
  const key = contractKey(contract.strikePrice, contract.optionType);
  const baseline = baselineFor(intraday, key);
  const points: OiHistoryPoint[] = [];

  for (let i = 0; i < intraday.length; i += 1) {
    const row = intraday[i]!.rows.get(key);
    const openInterest = row?.openInterest ?? null;
    const previousRow = i > 0 ? intraday[i - 1]!.rows.get(key) : undefined;
    const previousOi = previousRow?.openInterest ?? null;
    points.push({
      present: row !== undefined,
      openInterest,
      changeVsPreviousClose:
        openInterest !== null && baseline.value !== null ? openInterest - baseline.value : null,
      changeVsPreviousSnapshot:
        openInterest !== null && previousOi !== null ? openInterest - previousOi : null,
    });
  }

  return {
    strikePrice: contract.strikePrice,
    optionType: contract.optionType,
    previousCloseOpenInterest: baseline.value,
    baselineConsistent: baseline.consistent,
    points,
  };
}

const FIXED_SET_RULE =
  "Strikes present on both sides with open interest, and a reported previous close, in every intraday "
  + "snapshot of the session. Summing whatever strikes each snapshot happened to hold would count the "
  + "sliding strike window as an OI change.";

function buildTotals(intraday: readonly ObservationGroup[]): OiHistoryTotals | { unavailable: string } {
  if (intraday.length === 0) return { unavailable: "No intraday snapshots in this session." };

  const seen = new Set<number>();
  for (const group of intraday) for (const row of group.rows.values()) seen.add(row.strikePrice);

  const strikesUsed: number[] = [];
  const baselines = new Map<number, { calls: number; puts: number }>();
  for (const strike of [...seen].sort((a, b) => a - b)) {
    const callKey = contractKey(strike, "CE");
    const putKey = contractKey(strike, "PE");
    const inEvery = intraday.every((group) => {
      const call = group.rows.get(callKey);
      const put = group.rows.get(putKey);
      return call !== undefined && put !== undefined && call.openInterest !== null && put.openInterest !== null;
    });
    if (!inEvery) continue;
    const callBaseline = baselineFor(intraday, callKey).value;
    const putBaseline = baselineFor(intraday, putKey).value;
    if (callBaseline === null || putBaseline === null) continue;
    strikesUsed.push(strike);
    baselines.set(strike, { calls: callBaseline, puts: putBaseline });
  }

  if (strikesUsed.length === 0) {
    return { unavailable: "No strike is present on both sides, with open interest, in every snapshot of this session." };
  }

  let previousCloseCalls = 0;
  let previousClosePuts = 0;
  for (const baseline of baselines.values()) {
    previousCloseCalls += baseline.calls;
    previousClosePuts += baseline.puts;
  }

  const points: OiHistoryTotalsPoint[] = intraday.map((group) => {
    let calls = 0;
    let puts = 0;
    for (const strike of strikesUsed) {
      calls += group.rows.get(contractKey(strike, "CE"))!.openInterest!;
      puts += group.rows.get(contractKey(strike, "PE"))!.openInterest!;
    }
    return {
      calls,
      puts,
      putCallRatio: calls > 0 ? puts / calls : null,
      callsChangeVsPreviousClose: calls - previousCloseCalls,
      putsChangeVsPreviousClose: puts - previousClosePuts,
    };
  });

  return {
    rule: FIXED_SET_RULE,
    strikesUsed,
    strikesExcluded: seen.size - strikesUsed.length,
    previousCloseCalls,
    previousClosePuts,
    points,
  };
}

function detectGaps(intraday: readonly ObservationGroup[]): OiCollectionGap[] {
  const gaps: OiCollectionGap[] = [];
  for (let i = 1; i < intraday.length; i += 1) {
    const from = intraday[i - 1]!.observedAt;
    const to = intraday[i]!.observedAt;
    const minutes = (to.getTime() - from.getTime()) / MS_PER_MINUTE;
    if (minutes > OI_COLLECTION_GAP_AFTER_MINUTES) {
      gaps.push({ from: from.toISOString(), to: to.toISOString(), minutes: Math.round(minutes) });
    }
  }
  return gaps;
}

export function buildOiHistory(
  rows: readonly OiHistoryRow[],
  options: { contracts: readonly ContractRef[] },
): OiHistoryResult {
  const groups = groupByObservation(rows);
  const intraday = groups.filter((group) => group.kind === "INTRADAY");
  const preOpenGroups = groups.filter((group) => group.kind === "PRE_OPEN_CARRYOVER");
  const preOpen = preOpenGroups.length > 0 ? toObservation(preOpenGroups[preOpenGroups.length - 1]!) : null;

  const last = intraday[intraday.length - 1];
  const selectableStrikes = last
    ? [...new Set([...last.rows.values()].map((row) => row.strikePrice))].sort((a, b) => a - b)
    : [];

  return {
    preOpen,
    observations: intraday.map(toObservation),
    collectionGaps: detectGaps(intraday),
    contracts: options.contracts.map((contract) => buildContractSeries(intraday, contract)),
    totals: buildTotals(intraday),
    selectableStrikes,
  };
}

/**
 * Contracts to chart when the caller names none: the at-the-money call and put, and the call and put
 * strikes holding the most open interest, all read from the last intraday snapshot.
 *
 * "Most open interest" is where positions sit, not a level price must respect, so these are offered as a
 * starting point for inspection and not as significant strikes.
 */
export function selectDefaultContracts(rows: readonly OiHistoryRow[]): ContractRef[] {
  const intraday = groupByObservation(rows).filter((group) => group.kind === "INTRADAY");
  const last = intraday[intraday.length - 1];
  if (!last) return [];

  const strikes = [...new Set([...last.rows.values()].map((row) => row.strikePrice))];
  if (strikes.length === 0) return [];

  const chosen: ContractRef[] = [];
  const add = (strikePrice: number, optionType: OptionType): void => {
    if (!last.rows.has(contractKey(strikePrice, optionType))) return;
    if (chosen.some((c) => c.strikePrice === strikePrice && c.optionType === optionType)) return;
    chosen.push({ strikePrice, optionType });
  };

  const spot = last.underlyingValue;
  if (spot !== null) {
    let atm = strikes[0]!;
    for (const strike of strikes) if (Math.abs(strike - spot) < Math.abs(atm - spot)) atm = strike;
    add(atm, "CE");
    add(atm, "PE");
  }

  for (const optionType of ["CE", "PE"] as const) {
    let best: { strike: number; oi: number } | null = null;
    for (const row of last.rows.values()) {
      if (row.optionType !== optionType || row.openInterest === null) continue;
      if (best === null || row.openInterest > best.oi) best = { strike: row.strikePrice, oi: row.openInterest };
    }
    if (best !== null) add(best.strike, optionType);
  }

  return chosen;
}

export type OiHistoryQueryParseResult =
  | {
    ok: true;
    value: { underlyingSymbol: string; expiryDate: string | null; sessionDate: string | null; contracts: ContractRef[] };
  }
  | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CONTRACT_TOKEN = /^(\d+(?:\.\d+)?)(CE|PE)$/;

/** A real calendar date: `2026-02-31` matches the pattern and is not one. */
function isRealIsoDate(text: string): boolean {
  if (!ISO_DATE.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/**
 * Validates the endpoint's query. `contracts` is a comma list of `<strike><CE|PE>`, e.g.
 * `22500CE,22500PE`. Limits are enforced here so a request cannot ask the database for an unbounded
 * number of series.
 */
export function parseOiHistoryQuery(input: {
  underlying: string | undefined;
  expiry: string | undefined;
  date: string | undefined;
  contracts: string | undefined;
}): OiHistoryQueryParseResult {
  const underlyingSymbol = (input.underlying?.trim() || "NIFTY50").toUpperCase();
  if (!/^[A-Z0-9&-]{1,20}$/.test(underlyingSymbol)) {
    return { ok: false, error: "`underlying` must be a symbol such as NIFTY50." };
  }

  const expiryDate = input.expiry?.trim() || null;
  if (expiryDate !== null && !isRealIsoDate(expiryDate)) {
    return { ok: false, error: "`expiry` must be a real ISO date (YYYY-MM-DD)." };
  }

  const sessionDate = input.date?.trim() || null;
  if (sessionDate !== null && !isRealIsoDate(sessionDate)) {
    return { ok: false, error: "`date` must be a real ISO date (YYYY-MM-DD), the IST session day." };
  }

  const contracts: ContractRef[] = [];
  const raw = input.contracts?.trim();
  if (raw) {
    for (const token of raw.split(",")) {
      const match = CONTRACT_TOKEN.exec(token.trim().toUpperCase());
      if (!match) {
        return { ok: false, error: `\`contracts\` entry "${token.trim()}" must look like 22500CE or 22500PE.` };
      }
      const strikePrice = Number(match[1]);
      if (!Number.isFinite(strikePrice) || strikePrice <= 0) {
        return { ok: false, error: `\`contracts\` entry "${token.trim()}" has an invalid strike.` };
      }
      const optionType = match[2] as OptionType;
      if (!contracts.some((c) => c.strikePrice === strikePrice && c.optionType === optionType)) {
        contracts.push({ strikePrice, optionType });
      }
    }
    if (contracts.length > MAX_OI_HISTORY_CONTRACTS) {
      return { ok: false, error: `\`contracts\` accepts at most ${MAX_OI_HISTORY_CONTRACTS} contracts.` };
    }
  }

  return { ok: true, value: { underlyingSymbol, expiryDate, sessionDate, contracts } };
}
