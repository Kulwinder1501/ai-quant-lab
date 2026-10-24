import { buildDepthLadder, MAX_STORED_LEVELS, type StoredDepthFrame } from "./depth-ladder.js";
import { baseUnderlying, parsePartialNote } from "./partial-run-note.js";

/**
 * The open checks of the 2026-10-24 deploy, answered from what one session stored. Pure: the CLI reads the rows, this says what they show.
 *
 * Four things could not be known on a Saturday and were left for the first live session after the deploy:
 * whether the depth collector stores 50 levels (and how clean those frames are, and whether the feed's whole-book totals stop at 50),
 * whether the chain collector stores the provider's Greeks, whether a partial option-chain run is recorded as one, and whether NIFTY
 * paper orders are sized in whole lots of 65. Each is a count, and each count is reported with the rule it is judged by.
 *
 * ## What the states mean
 * - `OK`: the stored data meets the stated rule.
 * - `CHECK`: it does not, or the rule cannot mean anything for this date. The lines say which.
 * - `NO_DATA`: nothing was stored for the item that day (a weekend, a holiday, a collector that did not run). That is not a pass.
 *
 * Observed counts that have no baseline to judge against (the share of depth frames whose book is incoherent) are reported without a
 * state of their own and never move the item to `CHECK`: a threshold chosen here would be a guess, so the same report can be run for an
 * earlier date to compare.
 */

/** The first session after the deploy that carries the collector changes. Before it, an absence is the old code, not a fault. */
export const DEPLOY_DATE = "2026-10-24";
/**
 * At least this share of a session's frames must have stored every level they carried (up to 50) for the item to read OK. A frame that
 * carried only 7 levels and stored 7 is not truncated; one that carried 50 and stored 10 is.
 */
export const UNTRUNCATED_SHARE = 0.95;
/** The stored levels hold at least this share of the feed's whole-book total: the totals then appear to stop at the stored levels. */
export const TOTALS_STOP_AT_STORED = 0.99;
/** ... and below this share the totals count clearly more than the stored levels. Between the two nothing is concluded. */
export const TOTALS_EXCEED_STORED = 0.95;

export type ItemState = "OK" | "CHECK" | "NO_DATA";

export interface DepthSessionInput {
  providerSymbol: string;
  /** Every in-session frame stored for the symbol that date. */
  frames: number;
  /** ... of which stored every level they carried, up to 50. */
  framesUntruncated: number;
  /** ... of which carried the feed's full 50 levels. */
  framesCarryingFullDepth: number;
  /** ... of which stored the full 50 levels. */
  framesWithFullDepth: number;
  maxLevelsStored: number | null;
  maxLevelsAvailable: number | null;
  /** A deterministic sample of those frames, read whole, for the checks that need the levels. */
  sample: readonly StoredDepthFrame[];
}

export interface VendorGreeksInput {
  underlying: string;
  snapshots: number;
  snapshotsWithVendor: number;
  rows: number;
  rowsWithVendor: number;
}

export interface ChainRunsInput {
  /** COMPLETED OPTION_CHAIN runs scheduled that IST date. */
  completedRuns: number;
  /** Their stored notes, one per run (null when a run has none). */
  notes: ReadonlyArray<string | null>;
}

export interface LotInput {
  symbol: string;
  lotSize: number;
  /** Paper trades opened that IST date on the instrument. */
  trades: number;
  /** ... whose quantity is not a whole multiple of the lot. */
  offLot: number;
}

export interface ReadinessInput {
  date: string;
  depth: readonly DepthSessionInput[];
  vendor: readonly VendorGreeksInput[];
  chainRuns: ChainRunsInput;
  lots: readonly LotInput[];
}

export interface ReadinessItem {
  id: "depth" | "vendor-greeks" | "partial-runs" | "lot-sizing";
  title: string;
  state: ItemState;
  lines: string[];
}

function percent(part: number, whole: number): string {
  return whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a";
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** The worst state of a set: any CHECK wins, then OK, and NO_DATA only when every part has none. */
function worst(states: readonly ItemState[]): ItemState {
  if (states.length === 0 || states.every((state) => state === "NO_DATA")) return "NO_DATA";
  return states.includes("CHECK") ? "CHECK" : "OK";
}

function depthSymbol(input: DepthSessionInput): { state: ItemState; lines: string[] } {
  if (input.frames === 0) return { state: "NO_DATA", lines: [`${input.providerSymbol}: no in-session depth frames are stored.`] };
  const lines: string[] = [];
  const untruncatedShare = input.framesUntruncated / input.frames;
  lines.push(
    `${input.providerSymbol}: ${input.framesUntruncated} of ${input.frames} frames stored every level they carried, up to ${MAX_STORED_LEVELS} (${percent(input.framesUntruncated, input.frames)}); `
    + `${input.framesCarryingFullDepth} carried the full ${MAX_STORED_LEVELS} and ${input.framesWithFullDepth} stored it. Most levels stored ${input.maxLevelsStored ?? "n/a"}, most carried ${input.maxLevelsAvailable ?? "n/a"}.`,
  );
  lines.push(`  Rule: at least ${UNTRUNCATED_SHARE * 100}% of frames untruncated, and at least one frame stored the full ${MAX_STORED_LEVELS} (a session whose frames carried fewer shows nothing about the cap).`);

  const ladders = input.sample.map((frame) => buildDepthLadder(frame, { now: frame.receivedAt, historical: true }));
  const incoherent = ladders.filter((ladder) => !ladder.coherent).length;
  lines.push(
    ladders.length === 0
      ? "  No frame was sampled, so the book's coherence is not assessed."
      : `  Of ${ladders.length} sampled frames, ${incoherent} failed the book's own invariants (${percent(incoherent, ladders.length)}). No threshold is set; run the report for an earlier date to compare.`,
  );

  // Whole-book totals against the stored levels, on frames where both sides actually hold all 50 levels.
  const full = ladders.filter((ladder) => ladder.coherent && ladder.bids.length === MAX_STORED_LEVELS && ladder.asks.length === MAX_STORED_LEVELS);
  const bidShares = full.map((ladder) => ladder.coverage.storedShareOfWholeBook.bid).filter((value): value is number => value !== null);
  const askShares = full.map((ladder) => ladder.coverage.storedShareOfWholeBook.ask).filter((value): value is number => value !== null);
  const bid = median(bidShares);
  const ask = median(askShares);
  if (bid === null || ask === null) {
    lines.push("  Whole-book totals: no sampled frame holds all 50 levels on both sides with a usable total, so whether the totals stop at 50 is not assessed.");
  } else {
    const verdict = bid >= TOTALS_STOP_AT_STORED && ask >= TOTALS_STOP_AT_STORED
      ? "the stored levels hold about all of the total, so the feed's totals appear to count only those levels"
      : bid <= TOTALS_EXCEED_STORED && ask <= TOTALS_EXCEED_STORED
        ? "the total is clearly larger than the stored levels, so it counts more than the 50 levels"
        : "neither clearly, so nothing is concluded";
    lines.push(
      `  Whole-book totals: the stored 50 levels are a median ${(bid * 100).toFixed(1)}% of the bid total and ${(ask * 100).toFixed(1)}% of the ask total over ${full.length} full frames: ${verdict}.`,
    );
  }

  return { state: untruncatedShare >= UNTRUNCATED_SHARE && input.framesWithFullDepth > 0 ? "OK" : "CHECK", lines };
}

function depthItem(input: ReadinessInput): ReadinessItem {
  const parts = input.depth.map(depthSymbol);
  return {
    id: "depth",
    title: "Depth collector at 50 levels",
    state: parts.length === 0 ? "NO_DATA" : worst(parts.map((part) => part.state)),
    lines: parts.length === 0 ? ["No depth frames are stored for this date."] : parts.flatMap((part) => part.lines),
  };
}

function vendorItem(input: ReadinessInput): ReadinessItem {
  if (input.vendor.length === 0 || input.vendor.every((entry) => entry.snapshots === 0)) {
    return { id: "vendor-greeks", title: "Fyers Greeks stored with the chain", state: "NO_DATA", lines: ["No in-session option-chain snapshot is stored for this date."] };
  }
  const states: ItemState[] = [];
  const lines: string[] = [];
  for (const entry of input.vendor) {
    if (entry.snapshots === 0) {
      states.push("NO_DATA");
      lines.push(`${entry.underlying}: no in-session snapshot stored.`);
      continue;
    }
    lines.push(`${entry.underlying}: ${entry.snapshotsWithVendor} of ${entry.snapshots} snapshots carry Fyers Greeks; ${entry.rowsWithVendor} of ${entry.rows} contract rows (${percent(entry.rowsWithVendor, entry.rows)}).`);
    states.push(entry.snapshotsWithVendor === entry.snapshots ? "OK" : "CHECK");
  }
  lines.push("Rule: every in-session snapshot carries Greeks on some rows (a row without a value is the provider not sending one, not zero).");
  if (input.date < DEPLOY_DATE) {
    lines.push(`This date is before ${DEPLOY_DATE}: the collector did not store Fyers Greeks yet, so a CHECK here is the old code, not a fault.`);
    return { id: "vendor-greeks", title: "Fyers Greeks stored with the chain", state: "CHECK", lines };
  }
  return { id: "vendor-greeks", title: "Fyers Greeks stored with the chain", state: worst(states), lines };
}

function partialItem(input: ReadinessInput): ReadinessItem {
  const { completedRuns, notes } = input.chainRuns;
  if (completedRuns === 0) {
    return { id: "partial-runs", title: "Partial option-chain runs recorded", state: "NO_DATA", lines: ["No completed option-chain run is stored for this date."] };
  }
  const failuresByUnderlying = new Map<string, number>();
  let partialRuns = 0;
  for (const note of notes) {
    const failures = parsePartialNote(note);
    if (failures === null || failures.length === 0) continue;
    partialRuns += 1;
    // A run counts once per underlying, even when both of its expiries failed.
    for (const name of new Set(failures.map((failure) => baseUnderlying(failure.underlyingSymbol)))) {
      failuresByUnderlying.set(name, (failuresByUnderlying.get(name) ?? 0) + 1);
    }
  }
  const lines = [`${partialRuns} of ${completedRuns} completed option-chain runs recorded a partial failure.`];
  for (const [name, count] of [...failuresByUnderlying].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`  ${name}: ${count} ${count === 1 ? "run" : "runs"} could not collect it.`);
  }
  if (input.date < DEPLOY_DATE) {
    lines.push(`This date is before ${DEPLOY_DATE}: runs could not record a partial failure then, so a count of zero says nothing.`);
    return { id: "partial-runs", title: "Partial option-chain runs recorded", state: "CHECK", lines };
  }
  lines.push(partialRuns === 0
    ? "Zero is the expected reading on a healthy day; the note is only proven to be written once one run has recorded a failure."
    : "Each partial run is a gap in that underlying's chain series for that run; the data-coverage view lists them.");
  return { id: "partial-runs", title: "Partial option-chain runs recorded", state: partialRuns === 0 ? "OK" : "CHECK", lines };
}

function lotItem(input: ReadinessInput): ReadinessItem {
  const withTrades = input.lots.filter((entry) => entry.trades > 0);
  if (withTrades.length === 0) {
    return { id: "lot-sizing", title: "Paper orders in whole lots", state: "NO_DATA", lines: ["No paper trade was opened on a lot-sized instrument on this date."] };
  }
  const lines = withTrades.map((entry) => `${entry.symbol} (lot ${entry.lotSize}): ${entry.trades} paper ${entry.trades === 1 ? "trade" : "trades"} opened, ${entry.offLot} not a whole multiple of the lot.`);
  lines.push("Rule: no trade opened that date has a quantity that is not a whole multiple of the instrument's lot.");
  if (input.date < DEPLOY_DATE) {
    lines.push(`This date is before ${DEPLOY_DATE}: NIFTY50 trades were sized at 75 units a lot until the correction to 65, so off-lot rows there are history, not a fault.`);
  }
  return { id: "lot-sizing", title: "Paper orders in whole lots", state: withTrades.some((entry) => entry.offLot > 0) ? "CHECK" : "OK", lines };
}

export function buildReadiness(input: ReadinessInput): ReadinessItem[] {
  return [depthItem(input), vendorItem(input), partialItem(input), lotItem(input)];
}

export function formatReadiness(date: string, items: readonly ReadinessItem[]): string[] {
  const output = [`Session readiness for ${date} (IST). Reads what is stored; nothing here is a trading signal.`];
  for (const item of items) {
    output.push("", `[${item.state}] ${item.title}`);
    for (const line of item.lines) output.push(`  ${line}`);
  }
  return output;
}
