/**
 * Point-in-time option-chain PCR signal: the selection rules, shared constants and result shape
 * used by `PostgresStrategyMarketContextRepository.resolveOptionChainSignal`.
 *
 * Kept as pure functions so the rules that decide WHICH book feeds Pillar C are unit-tested
 * without a database, and so `apps/ml/oi_pcr_signal_check.py` and
 * `apps/ml/run_hybrid_confluence_backtest.py` can mirror exactly the same rules (they carry the
 * same constants with a pointer back here).
 *
 * ## The rules (identical in TS and both Python scripts)
 *
 * 1. **Expiry first.** Choose the nearest expiry from the stored calendar whose settlement
 *    (15:30 IST on the expiry date) is strictly AFTER the decision time. A date-only test
 *    (`expiry_date >= observed_at::date`) kept counting books of contracts that had already
 *    settled once the 15:30 close passed.
 * 2. **Then the snapshot.** Take the latest snapshot of THAT (symbol, expiry) observed at or
 *    before the decision time. The collector stores the front book and the "tradable roll" book
 *    about 0.2s apart, one expiry per snapshot, so "latest observed_at across expiries" is the
 *    FARTHER expiry. Selecting the snapshot before the expiry is what makes it the nearest.
 * 3. **Session hygiene.** Only snapshots observed inside 09:15:00-15:30:00 IST are eligible: a
 *    09:11 pre-open poll carries the previous day's OI and a 15:53 poll is post-close.
 * 4. **Staleness.** The snapshot may be at most `OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES` old at the
 *    decision time; beyond that the PCR is unavailable and the reason is `STALE` (explicit, not a
 *    silent null).
 * 5. **Completeness.** Any contract in the aggregate with missing OI makes the PCR unavailable
 *    (`INCOMPLETE_OPEN_INTEREST`); missing OI is unknown, not zero.
 */

/**
 * The one staleness ceiling for the PCR gate, in minutes. Live gate, backtest
 * (`run_hybrid_confluence_backtest.py`) and `oi_pcr_signal_check.py` all use this value.
 *
 * Cadence math: the chain collector polls every 12 minutes (median) and up to 18 minutes (measured
 * p90 17.999 over the last 30 days of NIFTY50 in-session polls; worst case 48 min across a
 * restart). A bar closing just before the next poll therefore sees a snapshot up to ~18 minutes
 * old on a perfectly healthy collector. A 15-minute ceiling rejected that healthy case (33% of
 * NIFTY 5m bars got pcr=null and Pillar C silently rejected), while the backtest ran with 60,
 * so the validated gate and the live gate were different gates. 20 minutes admits one full
 * 18-minute cycle plus jitter and still refuses a snapshot that has missed a poll (>= ~24 min).
 */
export const OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES = 20;

/** Cash-session window in IST, as milliseconds from IST midnight. 09:15:00 .. 15:30:00 inclusive. */
export const SESSION_OPEN_IST_MS = (9 * 60 + 15) * 60_000;
export const SESSION_CLOSE_IST_MS = (15 * 60 + 30) * 60_000;
const IST_OFFSET_MS = 330 * 60_000;
const MS_PER_DAY = 24 * 60 * 60_000;

/**
 * What the stored PCR is computed over. The collector asks Fyers for `strikecount` strikes per
 * side of the money (default 10-15) at the time of collection, so the sums cover a spot-recentred
 * WINDOW of strikes -- not the whole exchange chain. Labelled so nobody reads it as full-chain PCR.
 */
export const OPTION_CHAIN_PCR_SCOPE = "STRIKE_WINDOW_AROUND_SPOT" as const;

export type OptionChainPcrUnavailableReason =
  | "NO_SNAPSHOT"
  | "NO_UNSETTLED_EXPIRY"
  | "STALE"
  | "INCOMPLETE_OPEN_INTEREST"
  | "NO_CALL_OPEN_INTEREST";

/**
 * The signal handed to strategies. A superset of `StrategyMarketContext["optionChainSignal"]`, so
 * stored JSON consumers that read `pcr`, `callOpenInterest`, `putOpenInterest`, `observedAt` and
 * `ageMinutes` keep working unchanged.
 */
export interface OptionChainSignal {
  /**
   * Put OI / call OI over the stored strike window of the nearest unsettled expiry. Identical to
   * `pcrWindowed`; the old name is kept so existing JSON consumers do not break. It is NOT a
   * whole-chain PCR.
   */
  pcr: number | null;
  /** Same value as `pcr`, under the name that says what it measures. */
  pcrWindowed: number | null;
  pcrScope: typeof OPTION_CHAIN_PCR_SCOPE;
  callOpenInterest: number | null;
  putOpenInterest: number | null;
  observedAt: Date | null;
  ageMinutes: number | null;
  /** `YYYY-MM-DD` of the expiry the PCR was computed for, when one was selected. */
  expiryDate: string | null;
  /** Why `pcr` is null; null when a PCR is available. */
  unavailableReason: OptionChainPcrUnavailableReason | null;
  /** Human-readable form of `unavailableReason`, e.g. "PCR unavailable (stale)". */
  unavailableMessage: string | null;
}

const UNAVAILABLE_MESSAGES: Record<OptionChainPcrUnavailableReason, string> = {
  NO_SNAPSHOT: "PCR unavailable (no in-session option-chain snapshot for the nearest expiry)",
  NO_UNSETTLED_EXPIRY: "PCR unavailable (no listed expiry settles after the decision time)",
  STALE: "PCR unavailable (stale)",
  INCOMPLETE_OPEN_INTEREST: "PCR unavailable (a contract in the window has missing open interest)",
  NO_CALL_OPEN_INTEREST: "PCR unavailable (zero call open interest)",
};

export function unavailableOptionChainSignal(
  reason: OptionChainPcrUnavailableReason,
  extras: Partial<Pick<OptionChainSignal, "expiryDate" | "observedAt" | "ageMinutes">> = {},
): OptionChainSignal {
  return {
    pcr: null,
    pcrWindowed: null,
    pcrScope: OPTION_CHAIN_PCR_SCOPE,
    callOpenInterest: null,
    putOpenInterest: null,
    observedAt: extras.observedAt ?? null,
    ageMinutes: extras.ageMinutes ?? null,
    expiryDate: extras.expiryDate ?? null,
    unavailableReason: reason,
    unavailableMessage: UNAVAILABLE_MESSAGES[reason],
  };
}

/** Settlement instant of an expiry date: 15:30 IST (10:00 UTC) on that date. */
export function expirySettlementInstant(expiryDate: string): Date {
  return new Date(`${expiryDate}T10:00:00.000Z`);
}

/**
 * Rule 1: nearest expiry whose 15:30 IST settlement is strictly after `decisionTime`.
 * `expiryDates` are `YYYY-MM-DD` strings (any order, duplicates allowed). Null when none.
 */
export function selectNearestUnsettledExpiry(
  expiryDates: readonly string[],
  decisionTime: Date,
): string | null {
  const unsettled = [...new Set(expiryDates)]
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .filter((date) => expirySettlementInstant(date).getTime() > decisionTime.getTime())
    .sort();
  return unsettled[0] ?? null;
}

/** Rule 3: true when `observedAt` falls inside 09:15:00-15:30:00 IST (inclusive). */
export function isWithinCashSession(observedAt: Date): boolean {
  const istMsOfDay = (((observedAt.getTime() + IST_OFFSET_MS) % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  return istMsOfDay >= SESSION_OPEN_IST_MS && istMsOfDay <= SESSION_CLOSE_IST_MS;
}

/**
 * Rules 4 and 5 applied to an already-selected snapshot's aggregate, producing the final signal.
 * `contractsWithMissingOpenInterest` counts contracts of the selected book with null OI.
 */
export function buildOptionChainSignal(input: {
  expiryDate: string;
  observedAt: Date;
  decisionTime: Date;
  callOpenInterest: number;
  putOpenInterest: number;
  contracts: number;
  contractsWithMissingOpenInterest: number;
  maxAgeMinutes?: number;
}): OptionChainSignal {
  const ageMinutes = (input.decisionTime.getTime() - input.observedAt.getTime()) / 60_000;
  const common = { expiryDate: input.expiryDate, observedAt: input.observedAt, ageMinutes };
  if (input.contracts === 0) return unavailableOptionChainSignal("NO_SNAPSHOT", common);
  if (ageMinutes > (input.maxAgeMinutes ?? OPTION_CHAIN_MAX_SNAPSHOT_AGE_MINUTES)) {
    return unavailableOptionChainSignal("STALE", common);
  }
  if (input.contractsWithMissingOpenInterest > 0) {
    return unavailableOptionChainSignal("INCOMPLETE_OPEN_INTEREST", common);
  }
  if (!(input.callOpenInterest > 0)) return unavailableOptionChainSignal("NO_CALL_OPEN_INTEREST", common);

  const pcr = input.putOpenInterest / input.callOpenInterest;
  return {
    pcr,
    pcrWindowed: pcr,
    pcrScope: OPTION_CHAIN_PCR_SCOPE,
    callOpenInterest: input.callOpenInterest,
    putOpenInterest: input.putOpenInterest,
    observedAt: input.observedAt,
    ageMinutes,
    expiryDate: input.expiryDate,
    unavailableReason: null,
    unavailableMessage: null,
  };
}

/**
 * Maximum age of a depth frame at the candle close for the live order-book gate, in milliseconds.
 *
 * Depth frames arrive at up to 1000+/s per active contract, so the latest frame at a bar close is
 * normally well under a second old; 5 seconds tolerates a brief feed hiccup without letting the
 * gate read a book from a previous bar. Older than this, or no frame at all, is "no depth" -- a
 * missing book must never be turned into a zero imbalance.
 */
export const DEPTH_FRAME_MAX_AGE_MS = 5_000;
