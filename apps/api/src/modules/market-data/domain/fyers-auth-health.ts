/**
 * Assesses whether the stored Fyers credential will carry the trading session.
 *
 * A refresh normally renews the access token without a human, but when it refuses there is no
 * automated fallback — only an interactive login — so this reports rather than tries to fix.
 * What it closes is the gap upstream: nothing proactively checked the credential before it
 * lapsed, and nothing read the failures `scheduled_job_runs` already records, so a lapsed
 * token was discovered only when the option-chain expiry gate started refusing trades
 * mid-session.
 *
 * **It used to watch the wrong clock.** The verdict came from `refresh_token_expires_at` with
 * a two-day window, on the assumption that an expiring access token is always refreshed
 * programmatically in time. On 2026-08-05 refresh failed with `HTTP 400, code -16 — Refresh
 * token API is currently disabled to comply with SEBI regulations`, killing a backfill
 * mid-run. It then recovered: a refresh succeeded 19 minutes later and cleared the error, so
 * the outage was transient rather than the permanent removal it announced.
 *
 * Transient is enough to matter. While it lasted, `refresh_token_expires_at` read two weeks
 * out and the credential looked healthy, so the old check would have reported OK while every
 * Fyers job failed — which is the likely shape of the recurring OPTION_CHAIN and EOD_PIPELINE
 * failures.
 *
 * So the access token is the clock, and the question is not "how many days left" but **"will
 * this survive today's session?"** — the check runs once at 08:00 IST, before the 09:15 open,
 * and a token that dies at noon strands the afternoon whether or not a refresh would normally
 * have covered it. Access tokens observed lasting ~8 hours.
 */

export type FyersAuthHealthStatus = "OK" | "EXPIRING_SOON" | "ERROR" | "EXPIRED" | "MISSING";

export interface FyersAuthHealthInput {
  now: Date;
  hasCredential: boolean;
  /** The clock that decides usability, since nothing but a human can renew it. */
  accessTokenExpiresAt: Date | null;
  /**
   * Reported for context only. A comfortable window here does not mean the access token is
   * usable *now*, and treating it as the health clock is the bug this module carried.
   */
  refreshTokenExpiresAt: Date | null;
  lastError: string | null;
  /** FAILED scheduled_job_runs for Fyers-dependent jobs within the lookback window. */
  recentJobFailures: number;
  /**
   * The instant the token must still be valid at — normally today's 15:30 IST close.
   *
   * Passed in rather than derived, so session-calendar knowledge stays with the caller and
   * this stays a pure comparison.
   */
  mustRemainValidUntil?: Date;
}

export interface FyersAuthHealthAssessment {
  status: FyersAuthHealthStatus;
  reasons: string[];
}

const RENEW = "Refresh first; if it answers code -16, `npm run data:auth:fyers` is an "
  + "interactive login that always works.";

/** MISSING is worse than EXPIRED, which is worse than an active-but-erroring credential. */
const SEVERITY: Record<FyersAuthHealthStatus, number> = {
  OK: 0,
  EXPIRING_SOON: 1,
  ERROR: 2,
  EXPIRED: 3,
  MISSING: 4,
};

export function assessFyersAuthHealth(input: FyersAuthHealthInput): FyersAuthHealthAssessment {
  if (!input.hasCredential) {
    return {
      status: "MISSING",
      reasons: [`No Fyers credential is stored. ${RENEW}`],
    };
  }

  const reasons: string[] = [];
  let status: FyersAuthHealthStatus = "OK";
  const escalate = (candidate: FyersAuthHealthStatus, reason: string): void => {
    reasons.push(reason);
    if (SEVERITY[candidate] > SEVERITY[status]) status = candidate;
  };

  const expiresAt = input.accessTokenExpiresAt;
  if (expiresAt === null || Number.isNaN(expiresAt.getTime())) {
    escalate(
      "EXPIRED",
      `The stored credential has no usable access-token expiry, so it cannot be assumed `
      + `usable. ${RENEW}`,
    );
  } else if (expiresAt.getTime() <= input.now.getTime()) {
    escalate(
      "EXPIRED",
      `The Fyers access token expired at ${expiresAt.toISOString()}. Every Fyers job will fail, `
      + `and the option-chain expiry gate will refuse new option trades. ${RENEW}`,
    );
  } else if (input.mustRemainValidUntil
    && expiresAt.getTime() < input.mustRemainValidUntil.getTime()) {
    // Not "expiring soon" in the abstract: it dies *before the session ends*, so the
    // afternoon's collection intervals are already lost unless someone logs in. Those
    // intervals cannot be backfilled.
    escalate(
      "EXPIRING_SOON",
      `The Fyers access token expires at ${expiresAt.toISOString()}, before the session ends at `
      + `${input.mustRemainValidUntil.toISOString()}. Collection will stop mid-session, and `
      + `option-chain intervals cannot be backfilled. ${RENEW}`,
    );
  }

  // Surfaced because a reader who sees a fortnight here would otherwise conclude there is
  // nothing to do — exactly the mistake this module used to make on their behalf.
  if (input.refreshTokenExpiresAt && status !== "OK") {
    reasons.push(
      `For context, refresh_token_expires_at is ${input.refreshTokenExpiresAt.toISOString()}, `
      + "which says nothing about whether the access token is usable right now.",
    );
  }

  if (input.lastError) {
    escalate("ERROR", `Last recorded Fyers error: ${input.lastError}`);
  }

  if (input.recentJobFailures > 0) {
    escalate(
      "ERROR",
      `${input.recentJobFailures} Fyers-dependent scheduled job run(s) failed in the lookback `
      + "window. A lapsed access token is the most common cause.",
    );
  }

  return { status, reasons };
}
