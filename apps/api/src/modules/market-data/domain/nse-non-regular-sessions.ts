/** Exchange-announced sessions that do not have the regular weekday 09:15-15:30 shape. */
export interface KnownNseNonRegularSession {
  readonly sessionDate: string;
  readonly reason: string;
  readonly circularReference: string;
}

export const KNOWN_NSE_NON_REGULAR_SESSIONS_V1: readonly KnownNseNonRegularSession[] = [
  { sessionDate: "2023-11-12", reason: "Diwali Muhurat evening session", circularReference: "NSE/CMTR/59124" },
  { sessionDate: "2024-01-20", reason: "Saturday live trading session", circularReference: "NSE/MSD/60340" },
  { sessionDate: "2024-03-02", reason: "Saturday primary/DR special live sessions", circularReference: "NSE/MSD/60677" },
  { sessionDate: "2024-05-18", reason: "Saturday primary/DR special live sessions", circularReference: "NSE/MSD/61893" },
  { sessionDate: "2024-11-01", reason: "Diwali Muhurat evening session", circularReference: "NSE/CMTR/64628" },
  { sessionDate: "2025-02-01", reason: "Saturday Union Budget live session", circularReference: "NSE/CMTR/65729" },
  { sessionDate: "2025-10-21", reason: "Diwali Muhurat afternoon session", circularReference: "NSE/CMTR/70319" },
  { sessionDate: "2026-02-01", reason: "Sunday Union Budget live session", circularReference: "NSE/CMTR/72349" },
] as const;

export function knownNseNonRegularSessionMap(): ReadonlyMap<string, KnownNseNonRegularSession> {
  return new Map(KNOWN_NSE_NON_REGULAR_SESSIONS_V1.map((session) => [session.sessionDate, session]));
}
