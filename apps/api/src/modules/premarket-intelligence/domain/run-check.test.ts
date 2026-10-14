import { describe, expect, it } from "vitest";
import { assessPremarketRun, type PremarketRunEvidence } from "./run-check.js";

const at = (hhmm: string, date = "2026-10-14"): Date => new Date(`${date}T${hhmm}:00+05:30`);

const base: PremarketRunEvidence = {
  sessionDate: "2026-10-14",
  holiday: null,
  terminal: null,
  attemptStatuses: [],
  jobRunStatuses: [],
  firstSlotTimerFiredAt: null,
  finalSlotTimerFiredAt: null,
  processStartedAt: at("06:00"),
  firstSlotDueAt: at("08:52"),
  finalSlotDueAt: at("08:57"),
};

describe("assessPremarketRun", () => {
  it("accepts a stored result, whatever the model did", () => {
    const verdict = assessPremarketRun({ ...base, terminal: { status: "VALID", llmStatus: "VALIDATED" } });
    expect(verdict.outcome).toBe("OK");
    expect(verdict.detail).toContain("VALIDATED");
    expect(assessPremarketRun({ ...base, terminal: { status: "VALID", llmStatus: "FAILED" } }).outcome).toBe("OK");
  });

  it("expects nothing on a holiday, even with no evidence at all", () => {
    expect(assessPremarketRun({ ...base, holiday: "Diwali" }).outcome).toBe("HOLIDAY");
  });

  it("reports a recorded run that stored nothing, with what was recorded", () => {
    const verdict = assessPremarketRun({ ...base, jobRunStatuses: ["COMPLETED"], attemptStatuses: ["FAILED", "FAILED"] });
    expect(verdict.outcome).toBe("RAN_NO_RESULT");
    expect(verdict.detail).toContain("FAILED,FAILED");
  });

  // 2026-10-14: the scheduler was up and busy, and neither slot left a trace.
  it("says the timers did not fire when the process was up through the window and neither fired", () => {
    const verdict = assessPremarketRun(base);
    expect(verdict.outcome).toBe("MISSED");
    expect(verdict.detail).toContain("neither the 08:52 nor the 08:57 timer fired");
    expect(verdict.detail).toContain("up since 06:00 IST");
  });

  it("blames a restart when the process started after the last slot was due", () => {
    const verdict = assessPremarketRun({ ...base, processStartedAt: at("09:30") });
    expect(verdict.outcome).toBe("MISSED");
    expect(verdict.detail).toContain("started at 09:30 IST, after the 08:57 slot");
  });

  it("says the job was not claimed when the timers fired but nothing was recorded", () => {
    const verdict = assessPremarketRun({
      ...base,
      firstSlotTimerFiredAt: at("08:52"),
      finalSlotTimerFiredAt: at("08:57"),
    });
    expect(verdict.outcome).toBe("MISSED");
    expect(verdict.detail).toContain("the timers fired");
    expect(verdict.detail).toContain("not claimed");
  });

  it("does not count a timer stamp from an earlier day as having fired today", () => {
    const verdict = assessPremarketRun({
      ...base,
      firstSlotTimerFiredAt: at("08:52", "2026-10-13"),
      finalSlotTimerFiredAt: at("08:57", "2026-10-13"),
    });
    expect(verdict.detail).toContain("neither the 08:52 nor the 08:57 timer fired");
  });

  it("treats a single timer firing as enough to say the timers are alive", () => {
    const verdict = assessPremarketRun({ ...base, finalSlotTimerFiredAt: at("08:57") });
    expect(verdict.detail).toContain("not claimed");
  });
});
