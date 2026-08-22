export interface DirectionalSessionExclusion {
  readonly sessionDate: string;
  readonly reason: string;
}

export interface DirectionalCandleExclusion {
  readonly openTime: string;
  readonly reason: string;
}

/**
 * Frozen exclusions for provider defects that cannot be repaired without inventing OHLC.
 * Each missing minute was re-requested from FYERS and rejected by the invariant
 * `low <= min(open, close) <= max(open, close) <= high`.
 */
const SESSION_EXCLUSIONS_V1: Readonly<Record<string, readonly DirectionalSessionExclusion[]>> = {
  NIFTYBEES: [
    { sessionDate: "2023-09-21", reason: "FYERS 1m opening candle violates OHLC bounds" },
  ],
  BANKBEES: [
    { sessionDate: "2023-09-21", reason: "FYERS 1m opening candle violates OHLC bounds" },
    { sessionDate: "2023-11-13", reason: "FYERS 1m opening candle violates OHLC bounds" },
    { sessionDate: "2023-11-21", reason: "FYERS 1m candle at 11:50 IST violates OHLC bounds" },
    { sessionDate: "2024-02-09", reason: "FYERS 1m opening candle violates OHLC bounds" },
  ],
};

/** Exact settled FYERS prints outside the continuous session; retained in storage, excluded here. */
const CANDLE_EXCLUSIONS_V1: Readonly<Record<string, readonly DirectionalCandleExclusion[]>> = {
  NIFTYBEES: [
    { openTime: "2023-06-27T10:00:00.000Z", reason: "settled FYERS closing-session print at 15:30 IST" },
  ],
  BANKBEES: [
    { openTime: "2023-04-18T10:00:00.000Z", reason: "settled FYERS closing-session print at 15:30 IST" },
  ],
};

export function phase29DataQualitySessionExclusionMap(
  instrument: string,
): ReadonlyMap<string, DirectionalSessionExclusion> {
  const exclusions = SESSION_EXCLUSIONS_V1[instrument.toUpperCase()] ?? [];
  return new Map(exclusions.map((exclusion) => [exclusion.sessionDate, exclusion]));
}

export function phase29DataQualityCandleExclusionMap(
  instrument: string,
): ReadonlyMap<number, DirectionalCandleExclusion> {
  const exclusions = CANDLE_EXCLUSIONS_V1[instrument.toUpperCase()] ?? [];
  return new Map(exclusions.map((exclusion) => [new Date(exclusion.openTime).getTime(), exclusion]));
}
