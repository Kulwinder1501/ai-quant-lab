/**
 * How old the stored quotes are and which contracts have stopped moving, as words and flags. Pure, no React.
 *
 * The figures come from `/api/v1/option-chain/quote-staleness` (see `quote-staleness.ts` in the API): the age of the newest stored
 * snapshot judged against the collector's recent cadence, and for each contract how many of the newest snapshots repeat its bid and
 * ask. This module only turns them into text. Neither says whether a price can be traded at: a repeated quote is a prompt to
 * look, not a verdict, because a far strike can sit still for hours.
 */

export type AgeState = "none" | "market-closed" | "awaiting-first" | "fresh" | "aging" | "overdue";

export interface AgeView {
  state: AgeState;
  newestAt: string | null;
  ageSeconds: number | null;
  expectedGapSeconds: number;
  expectedGapFrom: "observed" | "assumed";
  agingFactor: number;
  overdueFactor: number;
}

export interface ContractStalenessView {
  strike: number;
  side: "CE" | "PE";
  unchangedSnapshots: number;
  unchangedSinceAt: string;
}

export interface StalenessPayload {
  underlyingSymbol: string;
  expiryDate: string | null;
  asOf: string;
  marketOpen: boolean;
  holiday: string | null;
  window: number;
  snapshotTimes: string[];
  age: AgeView;
  contracts: ContractStalenessView[];
  definitions: Record<string, string>;
}

/** A repeat of this many newest snapshots in a row is worth a look. Two in a row is ordinary for any strike. */
export const UNCHANGED_FLAG_SNAPSHOTS = 3;

export function istClock(iso: string | null): string {
  if (iso === null) return "–";
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
}

/**
 * The age at `nowMs`, and its state. The server judged the age when it answered; the page's clock moves on, so a state of
 * fresh, aging or overdue is re-judged with the same rule (fresh up to the expected gap, aging up to the overdue factor times it,
 * overdue beyond). Every other state is the server's word and is kept: whether the market is open is not decided here.
 */
export function ageNow(age: AgeView, nowMs: number): { ageSeconds: number | null; state: AgeState } {
  if (age.newestAt === null) return { ageSeconds: null, state: age.state };
  const ageSeconds = Math.max(0, (nowMs - new Date(age.newestAt).getTime()) / 1000);
  if (age.state !== "fresh" && age.state !== "aging" && age.state !== "overdue") return { ageSeconds, state: age.state };
  if (ageSeconds <= age.expectedGapSeconds * age.agingFactor) return { ageSeconds, state: "fresh" };
  if (ageSeconds <= age.expectedGapSeconds * age.overdueFactor) return { ageSeconds, state: "aging" };
  return { ageSeconds, state: "overdue" };
}

/** An age as minutes (or hours and minutes), rounded down: `14 min`, `1 h 05 min`. */
export function ageText(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
}

const STATE_WORDS: Record<AgeState, string> = {
  none: "no snapshot stored",
  "market-closed": "market closed",
  "awaiting-first": "awaiting today's first snapshot",
  fresh: "fresh",
  aging: "aging",
  overdue: "overdue",
};

export function ageStateWord(state: AgeState): string {
  return STATE_WORDS[state];
}

/** The chain's age in one sentence, with what it is judged against. */
export function ageSentence(payload: StalenessPayload, nowMs: number): string {
  const { age } = payload;
  if (age.newestAt === null) return "No chain snapshot is stored for this underlying yet.";
  const { ageSeconds, state } = ageNow(age, nowMs);
  const base = `The stored chain was observed at ${istClock(age.newestAt)} IST, ${ageText(ageSeconds ?? 0)} ago`;
  if (state === "market-closed") {
    return `${base}. ${payload.holiday ? `The exchange is closed today (${payload.holiday})` : "The market is closed"}, so these are the last quotes of the most recent session and no age is judged.`;
  }
  if (state === "awaiting-first") return `${base}: from an earlier day. The first snapshot of today's session is not in yet.`;
  const gap = `${ageText(age.expectedGapSeconds)} between runs`;
  const judged = age.expectedGapFrom === "observed"
    ? `the longest gap lately was ${gap}`
    : `too few recent snapshots to see the cadence, so the schedule's widest gap (${gap}) is assumed`;
  if (state === "fresh") return `${base}: within the usual gap (${judged}).`;
  if (state === "aging") return `${base}: past the usual gap but not yet missed a run (${judged}).`;
  return `${base}: well past the usual gap, so runs have probably been missed (${judged}). Treat these quotes as old.`;
}

export interface ContractFlag {
  flagged: boolean;
  /** Short text for a table cell. */
  cell: string;
  /** The sentence for the card; null when there is nothing to say. */
  sentence: string | null;
}

/** Whether one contract's quote has repeated across enough snapshots to be worth a look. Not judged when the market is shut. */
export function contractFlag(contract: ContractStalenessView | undefined, marketOpen: boolean): ContractFlag {
  if (!contract) return { flagged: false, cell: "–", sentence: null };
  if (!marketOpen) return { flagged: false, cell: "–", sentence: null };
  if (contract.unchangedSnapshots < UNCHANGED_FLAG_SNAPSHOTS) return { flagged: false, cell: "moved", sentence: null };
  return {
    flagged: true,
    cell: `same ×${contract.unchangedSnapshots}`,
    sentence: `The bid and ask have been exactly the same in the last ${contract.unchangedSnapshots} snapshots, since ${istClock(contract.unchangedSinceAt)} IST. That is not proof the price is stale (a far strike can sit still), but check it against the live market before relying on the breakeven.`,
  };
}

export function stalenessKey(strike: number, side: "CE" | "PE"): string {
  return `${strike}|${side}`;
}

export function indexContracts(contracts: readonly ContractStalenessView[]): Map<string, ContractStalenessView> {
  return new Map(contracts.map((contract) => [stalenessKey(contract.strike, contract.side), contract]));
}
