import {
  KNOWN_NSE_NON_REGULAR_SESSIONS_V1,
  knownNseNonRegularSessionMap,
  type KnownNseNonRegularSession,
} from "../../../market-data/domain/nse-non-regular-sessions.js";

/** Phase 29 excludes genuine non-regular sessions from its regular-session experiment. */
export type ExcludedSpecialSession = KnownNseNonRegularSession;
export const PHASE_29_EXCLUDED_SPECIAL_SESSIONS_V1 = KNOWN_NSE_NON_REGULAR_SESSIONS_V1;

export function phase29ExcludedSpecialSessionMap(): ReadonlyMap<string, ExcludedSpecialSession> {
  return knownNseNonRegularSessionMap();
}
