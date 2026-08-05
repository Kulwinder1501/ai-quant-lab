import { describe, expect, it } from "vitest";
import { assessFyersAuthHealth, type FyersAuthHealthInput } from "./fyers-auth-health.js";

const NOW = new Date("2026-08-05T02:30:00.000Z");

function base(overrides: Partial<FyersAuthHealthInput> = {}): FyersAuthHealthInput {
  return {
    now: NOW,
    hasCredential: true,
    refreshTokenExpiresAt: new Date(NOW.getTime() + 10 * 24 * 60 * 60_000),
    lastError: null,
    recentJobFailures: 0,
    ...overrides,
  };
}

describe("assessFyersAuthHealth", () => {
  it("is OK when the refresh token is comfortably valid and nothing else is wrong", () => {
    const assessment = assessFyersAuthHealth(base());
    expect(assessment.status).toBe("OK");
    expect(assessment.reasons).toEqual([]);
  });

  it("reports MISSING when no credential is stored, ignoring every other input", () => {
    const assessment = assessFyersAuthHealth(base({
      hasCredential: false,
      lastError: "should be ignored",
      recentJobFailures: 5,
    }));
    expect(assessment.status).toBe("MISSING");
    expect(assessment.reasons).toHaveLength(1);
  });

  it("reports EXPIRED once the refresh token's expiry has passed", () => {
    const assessment = assessFyersAuthHealth(base({
      refreshTokenExpiresAt: new Date(NOW.getTime() - 60_000),
    }));
    expect(assessment.status).toBe("EXPIRED");
    expect(assessment.reasons[0]).toMatch(/expired/i);
  });

  it("reports EXPIRED when no expiry is on record at all", () => {
    const assessment = assessFyersAuthHealth(base({ refreshTokenExpiresAt: null }));
    expect(assessment.status).toBe("EXPIRED");
  });

  it("reports EXPIRING_SOON inside the warning window but before expiry", () => {
    const assessment = assessFyersAuthHealth(base({
      refreshTokenExpiresAt: new Date(NOW.getTime() + 12 * 60 * 60_000),
      warningWindowDays: 2,
    }));
    expect(assessment.status).toBe("EXPIRING_SOON");
  });

  it("does not warn outside the warning window", () => {
    const assessment = assessFyersAuthHealth(base({
      refreshTokenExpiresAt: new Date(NOW.getTime() + 5 * 24 * 60 * 60_000),
      warningWindowDays: 2,
    }));
    expect(assessment.status).toBe("OK");
  });

  it("reports ERROR when a last error is recorded even with a healthy expiry", () => {
    const assessment = assessFyersAuthHealth(base({ lastError: "Fyers rejected the appIdHash (-371)." }));
    expect(assessment.status).toBe("ERROR");
    expect(assessment.reasons[0]).toContain("-371");
  });

  it("reports ERROR when Fyers-dependent scheduled jobs have recently failed", () => {
    const assessment = assessFyersAuthHealth(base({ recentJobFailures: 3 }));
    expect(assessment.status).toBe("ERROR");
    expect(assessment.reasons[0]).toContain("3");
  });

  it("EXPIRED outranks a simultaneous ERROR condition", () => {
    const assessment = assessFyersAuthHealth(base({
      refreshTokenExpiresAt: new Date(NOW.getTime() - 60_000),
      lastError: "some transient error",
      recentJobFailures: 2,
    }));
    expect(assessment.status).toBe("EXPIRED");
    expect(assessment.reasons).toHaveLength(3);
  });
});
