import { describe, expect, it } from "vitest";
import { assessFyersAuthHealth, type FyersAuthHealthInput } from "./fyers-auth-health.js";

/** 08:00 IST, when the scheduler runs the check — before the 09:15 open. */
const NOW = new Date("2026-08-05T02:30:00.000Z");
/** 15:30 IST the same day. */
const SESSION_CLOSE = new Date("2026-08-05T10:00:00.000Z");

function base(overrides: Partial<FyersAuthHealthInput> = {}): FyersAuthHealthInput {
  return {
    now: NOW,
    hasCredential: true,
    accessTokenExpiresAt: new Date(SESSION_CLOSE.getTime() + 60 * 60_000),
    // Deliberately far out in every case below: a healthy-looking refresh expiry must never
    // be what makes the verdict OK.
    refreshTokenExpiresAt: new Date(NOW.getTime() + 15 * 24 * 60 * 60_000),
    lastError: null,
    recentJobFailures: 0,
    mustRemainValidUntil: SESSION_CLOSE,
    ...overrides,
  };
}

describe("assessFyersAuthHealth", () => {
  it("is OK when the access token outlives the session and nothing else is wrong", () => {
    const assessment = assessFyersAuthHealth(base());

    expect(assessment.status).toBe("OK");
    expect(assessment.reasons).toEqual([]);
  });

  // The bug this replaces. On 2026-08-05 refresh failed with code -16 for ~19 minutes while
  // refresh_token_expires_at read 2026-08-20, so the old check would have reported OK while
  // every Fyers job failed. A comfortable refresh window proves nothing about right now.
  it("reports EXPIRED on a dead access token even with a fortnight of refresh window left", () => {
    const assessment = assessFyersAuthHealth(base({
      accessTokenExpiresAt: new Date(NOW.getTime() - 60 * 60_000),
      refreshTokenExpiresAt: new Date(NOW.getTime() + 15 * 24 * 60 * 60_000),
    }));

    expect(assessment.status).toBe("EXPIRED");
    expect(assessment.reasons.join(" ")).toMatch(/access token expired/);
    expect(assessment.reasons.join(" ")).toMatch(/data:auth:fyers/);
    // And it must say the refresh window is not a reason for comfort.
    expect(assessment.reasons.join(" ")).toMatch(/says nothing about whether the access token/);
  });

  it("warns when the token dies mid-session, because those intervals cannot be backfilled", () => {
    const assessment = assessFyersAuthHealth(base({
      // Noon IST: alive now, dead well before the 15:30 close.
      accessTokenExpiresAt: new Date("2026-08-05T06:30:00.000Z"),
    }));

    expect(assessment.status).toBe("EXPIRING_SOON");
    expect(assessment.reasons.join(" ")).toMatch(/before the session ends/);
    expect(assessment.reasons.join(" ")).toMatch(/cannot be backfilled/);
  });

  it("does not warn about a token that expires after the close", () => {
    const assessment = assessFyersAuthHealth(base({
      accessTokenExpiresAt: new Date(SESSION_CLOSE.getTime() + 1_000),
    }));

    expect(assessment.status).toBe("OK");
  });

  it("treats a missing access expiry as unusable rather than assuming the best", () => {
    const assessment = assessFyersAuthHealth(base({ accessTokenExpiresAt: null }));

    expect(assessment.status).toBe("EXPIRED");
    expect(assessment.reasons.join(" ")).toMatch(/no usable access-token expiry/);
  });

  it("reports MISSING when there is no credential at all", () => {
    const assessment = assessFyersAuthHealth(base({ hasCredential: false }));

    expect(assessment.status).toBe("MISSING");
    expect(assessment.reasons.join(" ")).toMatch(/No Fyers credential is stored/);
  });

  it("surfaces a recorded provider error", () => {
    const assessment = assessFyersAuthHealth(base({
      lastError: "Refresh token API is currently disabled to comply with SEBI regulations.",
    }));

    expect(assessment.status).toBe("ERROR");
    expect(assessment.reasons.join(" ")).toMatch(/SEBI/);
  });

  it("counts recent Fyers job failures and names the usual cause", () => {
    const assessment = assessFyersAuthHealth(base({ recentJobFailures: 3 }));

    expect(assessment.status).toBe("ERROR");
    expect(assessment.reasons.join(" ")).toMatch(/3 Fyers-dependent scheduled job run\(s\) failed/);
    expect(assessment.reasons.join(" ")).toMatch(/lapsed access token/);
  });

  it("keeps the worst status when several things are wrong at once", () => {
    const assessment = assessFyersAuthHealth(base({
      accessTokenExpiresAt: new Date(NOW.getTime() - 60 * 60_000),
      lastError: "boom",
      recentJobFailures: 5,
    }));

    // EXPIRED outranks ERROR: the token is the thing that has to be fixed first.
    expect(assessment.status).toBe("EXPIRED");
    expect(assessment.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it("skips the session comparison when no deadline is supplied", () => {
    // After the close there is nothing left to strand, so the scheduler omits it.
    const assessment = assessFyersAuthHealth(base({
      accessTokenExpiresAt: new Date(NOW.getTime() + 60 * 60_000),
      mustRemainValidUntil: undefined,
    }));

    expect(assessment.status).toBe("OK");
  });
});
