/**
 * Assesses whether the stored Fyers credential is healthy enough to keep
 * trading eligible, and produces the reasons a human should act on.
 *
 * Fyers has no non-interactive re-authorization path -- a human must log in
 * again once the refresh token lapses -- so this deliberately does not try to
 * automate that step. What it closes is the gap upstream of it: today nothing
 * proactively checks the credential before it lapses, and nothing reads the
 * failures `scheduled_job_runs` already records, so a lapsed token is
 * discovered only when the option-chain expiry gate starts refusing trades
 * during a live session. This runs earlier and says so out loud.
 */

export type FyersAuthHealthStatus = "OK" | "EXPIRING_SOON" | "ERROR" | "EXPIRED" | "MISSING";

export interface FyersAuthHealthInput {
  now: Date;
  hasCredential: boolean;
  refreshTokenExpiresAt: Date | null;
  lastError: string | null;
  /** FAILED scheduled_job_runs for Fyers-dependent jobs within the lookback window. */
  recentJobFailures: number;
  /** Warn this many days before the refresh token actually lapses. */
  warningWindowDays?: number;
}

export interface FyersAuthHealthAssessment {
  status: FyersAuthHealthStatus;
  reasons: string[];
}

const DEFAULT_WARNING_WINDOW_DAYS = 2;

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
      reasons: ["No Fyers credential is stored. Run `npm run data:auth:fyers` to authorize."],
    };
  }

  const reasons: string[] = [];
  let status: FyersAuthHealthStatus = "OK";
  const escalate = (candidate: FyersAuthHealthStatus, reason: string): void => {
    reasons.push(reason);
    if (SEVERITY[candidate] > SEVERITY[status]) {
      status = candidate;
    }
  };

  const warningWindowDays = input.warningWindowDays ?? DEFAULT_WARNING_WINDOW_DAYS;
  const warningWindowMs = warningWindowDays * 24 * 60 * 60_000;
  if (!input.refreshTokenExpiresAt || input.refreshTokenExpiresAt.getTime() <= input.now.getTime()) {
    escalate(
      "EXPIRED",
      "The Fyers refresh token has expired. The option-chain expiry gate will start refusing new "
      + "option trades; re-run `npm run data:auth:fyers` before the next session.",
    );
  } else if (input.refreshTokenExpiresAt.getTime() - input.now.getTime() <= warningWindowMs) {
    escalate(
      "EXPIRING_SOON",
      `The Fyers refresh token expires at ${input.refreshTokenExpiresAt.toISOString()}, within the `
      + `${warningWindowDays}-day warning window. Re-run \`npm run data:auth:fyers\` before it lapses.`,
    );
  }

  if (input.lastError) {
    escalate("ERROR", `Last recorded Fyers error: ${input.lastError}`);
  }

  if (input.recentJobFailures > 0) {
    escalate(
      "ERROR",
      `${input.recentJobFailures} Fyers-dependent scheduled job run(s) failed in the lookback window.`,
    );
  }

  return { status, reasons };
}
