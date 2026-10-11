import { describe, expect, it } from "vitest";
import {
  deterministicDecisionId,
  MAX_DECISION_ATTEMPTS,
  resolveDecisionAttempt,
} from "./decision-identity.js";

const BAR = new Date("2026-10-09T10:00:00.000Z");
const base = { path: "native-pipeline", symbol: "BANKNIFTY", timeframe: "5m", barCloseTime: BAR };

describe("deterministicDecisionId", () => {
  it("is the same for the same bar, path and attempt", () => {
    expect(deterministicDecisionId({ ...base, attempt: 1 })).toBe(deterministicDecisionId({ ...base, attempt: 1 }));
  });

  it("is a well-formed UUID (version 5 layout)", () => {
    const id = deterministicDecisionId({ ...base, attempt: 1 });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("differs when any identifying part differs", () => {
    const reference = deterministicDecisionId({ ...base, attempt: 1 });
    const variants = [
      { ...base, attempt: 2 },
      { ...base, path: "structural-gate-v1", attempt: 1 },
      { ...base, symbol: "NIFTY50", attempt: 1 },
      { ...base, timeframe: "1m", attempt: 1 },
      { ...base, barCloseTime: new Date("2026-10-09T10:05:00.000Z"), attempt: 1 },
    ];
    const ids = variants.map(deterministicDecisionId);
    expect(new Set([reference, ...ids]).size).toBe(variants.length + 1);
  });

  it("refuses parts that would make the identity ambiguous or invalid", () => {
    expect(() => deterministicDecisionId({ ...base, symbol: "A|B", attempt: 1 })).toThrow(/must not contain/);
    expect(() => deterministicDecisionId({ ...base, path: " ", attempt: 1 })).toThrow(/non-empty path/);
    expect(() => deterministicDecisionId({ ...base, barCloseTime: new Date("nope"), attempt: 1 })).toThrow(/valid barCloseTime/);
    expect(() => deterministicDecisionId({ ...base, attempt: 0 })).toThrow(/attempt/);
    expect(() => deterministicDecisionId({ ...base, attempt: 1.5 })).toThrow(/attempt/);
  });
});

function ledger(states: Record<number, string>) {
  const calls: number[] = [];
  const idToAttempt = new Map<string, number>();
  for (let attempt = 1; attempt <= MAX_DECISION_ATTEMPTS + 1; attempt += 1) {
    idToAttempt.set(deterministicDecisionId({ ...base, attempt }), attempt);
  }
  return {
    calls,
    lastStateOf: async (decisionId: string): Promise<string | null> => {
      const attempt = idToAttempt.get(decisionId)!;
      calls.push(attempt);
      return states[attempt] ?? null;
    },
  };
}

describe("resolveDecisionAttempt", () => {
  it("decides a bar nobody has decided under attempt 1", async () => {
    const { lastStateOf } = ledger({});
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result).toEqual({ kind: "DECIDE", decisionId: deterministicDecisionId({ ...base, attempt: 1 }), attempt: 1 });
  });

  it.each(["REJECTED", "CLOSED_NO_ACTION", "EXECUTED"])("treats %s as final and skips the bar", async (state) => {
    const { lastStateOf } = ledger({ 1: state });
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result).toEqual({ kind: "ALREADY_DECIDED", decisionId: deterministicDecisionId({ ...base, attempt: 1 }), state });
  });

  it("retries a bar whose last attempt only deferred", async () => {
    const { lastStateOf } = ledger({ 1: "DEFERRED" });
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result).toEqual({ kind: "DECIDE", decisionId: deterministicDecisionId({ ...base, attempt: 2 }), attempt: 2 });
  });

  it("does not decide again after a deferred attempt was followed by a settled one", async () => {
    const { lastStateOf } = ledger({ 1: "DEFERRED", 2: "REJECTED" });
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result.kind).toBe("ALREADY_DECIDED");
  });

  it("moves past an attempt that died part-way through its stages", async () => {
    const { lastStateOf } = ledger({ 1: "THESIS_FORMED" });
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result).toMatchObject({ kind: "DECIDE", attempt: 2 });
  });

  it("stops after the attempt cap instead of looping", async () => {
    const all = Object.fromEntries(Array.from({ length: MAX_DECISION_ATTEMPTS }, (_, i) => [i + 1, "DEFERRED"]));
    const { lastStateOf, calls } = ledger(all);
    const result = await resolveDecisionAttempt(base, lastStateOf);
    expect(result).toEqual({ kind: "ATTEMPTS_EXHAUSTED", attempts: MAX_DECISION_ATTEMPTS });
    expect(calls).toHaveLength(MAX_DECISION_ATTEMPTS);
  });
});
