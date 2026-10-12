import { describe, expect, it, vi } from "vitest";
import type { LlmClient } from "../../../infrastructure/external/gemini-client.js";
import {
  RunPremarketBias,
  type AttemptStatus,
  type CaptureResult,
  type PremarketBiasStore,
  type SnapshotSource,
  type TerminalSnapshotRow,
} from "./run-premarket-bias.js";
import type { EvidenceItem, MarketSnapshot } from "../domain/snapshot.js";

// 08:52 IST on Monday 2026-10-12.
const NOW = new Date("2026-10-12T03:22:00.000Z");
const KEY_0850 = "ASIA_INDIA_PREMARKET_2026-10-12_0850_V1";

function evidence(category: EvidenceItem["category"], id: string, value: number | null = 0.24): EvidenceItem {
  return { id, category, label: category, value, unit: "PERCENT_CHANGE", observedAt: null, source: "t" };
}

function snapshot(items: EvidenceItem[]): MarketSnapshot {
  return {
    sessionDate: "2026-10-12", runSlot: KEY_0850, capturedAt: NOW.toISOString(), evidence: items,
    candidateLevels: [{ id: "level-nifty50-pdh", instrument: "NIFTY50", label: "Previous day high", price: 22600 }],
  };
}

function source(items: EvidenceItem[], diagnostics: Record<string, unknown> = {}): SnapshotSource {
  return { capture: async (): Promise<CaptureResult> => ({ snapshot: snapshot(items), diagnostics }) };
}

function fakeStore(existing = false) {
  const attempts: Array<{ status: AttemptStatus; errorDetails: Record<string, unknown> }> = [];
  const terminals: TerminalSnapshotRow[] = [];
  const store: PremarketBiasStore = {
    hasTerminal: async () => existing || terminals.length > 0,
    recordAttempt: async (a) => { attempts.push({ status: a.status, errorDetails: a.errorDetails }); },
    insertTerminal: async (row) => { if (terminals.length > 0) return false; terminals.push(row); return true; },
  };
  return { store, attempts, terminals };
}

const entry = (instrument: string) => ({
  instrument,
  opening_context: { expectation: "GAP_UP", reasoning: "GIFT is up." },
  intraday_context: { target_horizon: "FIRST_60_MINUTES", expected_direction: "UNCERTAIN", evidence_alignment: "MIXED", subjective_confidence: 0.5, reasoning: "Split." },
  full_session_context: { target_horizon: "FULL_SESSION", expected_direction: "NEUTRAL", evidence_alignment: "MIXED", subjective_confidence: 0.4, reasoning: "Quiet." },
  key_levels: instrument === "NIFTY50" ? [{ level_ref: "level-nifty50-pdh", role: "RESISTANCE" }] : [],
  evidence_ids: ["market-evidence-001"],
});
const validResponse = JSON.stringify({ assessments: [entry("NIFTY50"), entry("BANKNIFTY")] });

function llm(responses: Array<string | Error>): LlmClient & { calls: number } {
  const client = {
    model: "test-model",
    calls: 0,
    async completeJson() {
      const next = responses[Math.min(client.calls, responses.length - 1)]!;
      client.calls += 1;
      if (next instanceof Error) throw next;
      return { text: next, model: "test-model", finishReason: "STOP", promptTokens: 10, outputTokens: 20 };
    },
  };
  return client;
}

const gift = evidence("GIFT_NIFTY", "market-evidence-001", 0.24);
const run = (src: SnapshotSource, store: PremarketBiasStore, client: LlmClient | null) => new RunPremarketBias(src, store, client, () => NOW);

describe("RunPremarketBias", () => {
  it("stores the snapshot and baselines when no model is configured, and says so", async () => {
    const { store, terminals } = fakeStore();
    const result = await run(source([gift]), store, null).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });

    expect(result).toMatchObject({ outcome: "RECORDED", llmStatus: "NOT_CONFIGURED", logicalRunKey: KEY_0850 });
    expect(terminals[0]).toMatchObject({ status: "VALID", llmStatus: "NOT_CONFIGURED", assessments: null, assessmentDate: "2026-10-12" });
    expect(terminals[0]!.deterministicBaselines.NIFTY50.OPENING_GAP.GIFT_THRESHOLD).toBe("FLAT"); // 0.24 < 0.25
    expect(terminals[0]!.deterministicBaselines.BANKNIFTY.FIRST_60_MINUTES.ALWAYS_FLAT).toBe("FLAT");
  });

  it("persists a validated assessment with its prompt hash and the raw response for audit", async () => {
    const { store, terminals, attempts } = fakeStore();
    const client = llm([validResponse]);
    const result = await run(source([gift]), store, client).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });

    expect(result).toMatchObject({ outcome: "RECORDED", llmStatus: "VALIDATED", modelAttempts: 1 });
    const row = terminals[0]!;
    expect(row.assessments).toHaveLength(2);
    expect(row.assessments![0]!.key_levels[0]).toMatchObject({ levelRef: "level-nifty50-pdh", price: 22600 });
    expect(row.modelMetadata).toMatchObject({ model: "test-model", promptVersion: "premarket-v1", configVersion: "V1", rawResponse: validResponse });
    expect(String(row.modelMetadata.promptHash)).toMatch(/^[0-9a-f]{64}$/);
    expect(attempts.at(-1)!.status).toBe("SUCCESS");
  });

  it("retries once when the response fails validation, then accepts a good one", async () => {
    const { store, attempts } = fakeStore();
    const client = llm([JSON.stringify({ assessments: [entry("NIFTY50")] }), validResponse]);
    const result = await run(source([gift]), store, client).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });

    expect(result).toMatchObject({ llmStatus: "VALIDATED", modelAttempts: 2 });
    expect(attempts.map((a) => a.status)).toEqual(["FAILED", "SUCCESS"]);
    expect(JSON.stringify(attempts[0]!.errorDetails)).toContain("missing assessment for BANKNIFTY");
  });

  it("records FAILED, not a repaired answer, when the model never produces a valid one", async () => {
    const { store, terminals, attempts } = fakeStore();
    const client = llm(["not json at all"]);
    const result = await run(source([gift]), store, client).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });

    expect(client.calls).toBe(2);
    expect(result).toMatchObject({ outcome: "RECORDED", llmStatus: "FAILED", modelAttempts: 2 });
    expect(terminals[0]).toMatchObject({ status: "VALID", llmStatus: "FAILED", assessments: null });
    expect(attempts.every((a) => a.status === "FAILED")).toBe(true);
  });

  it("treats a request error as a failed attempt and still stores the baseline", async () => {
    const { store, terminals } = fakeStore();
    const result = await run(source([gift]), store, llm([new Error("boom")])).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });
    expect(result.llmStatus).toBe("FAILED");
    expect(terminals[0]!.deterministicBaselines).toBeDefined();
  });

  it("does not make a model failure terminal on a non-final try, so the next try can recover it", async () => {
    const { store, terminals } = fakeStore();
    const first = await run(source([gift]), store, llm([new Error("503")])).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    expect(first).toMatchObject({ outcome: "MODEL_RETRY_PENDING", llmStatus: "FAILED" });
    expect(terminals).toHaveLength(0);

    // The :57 try: Gemini is back, and the day's model result is recorded instead of lost.
    const second = await run(source([gift]), store, llm([validResponse])).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });
    expect(second).toMatchObject({ outcome: "RECORDED", llmStatus: "VALIDATED" });
    expect(terminals).toHaveLength(1);
  });

  it("records FAILED on the final try when the model is still down", async () => {
    const { store, terminals } = fakeStore();
    await run(source([gift]), store, llm([new Error("503")])).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    await run(source([gift]), store, llm([new Error("503")])).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });
    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({ status: "VALID", llmStatus: "FAILED" });
  });

  it("stores a not-configured day on the first try -- there is nothing to retry", async () => {
    const { store, terminals } = fakeStore();
    const result = await run(source([gift]), store, null).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    expect(result.outcome).toBe("RECORDED");
    expect(terminals[0]!.llmStatus).toBe("NOT_CONFIGURED");
  });

  it("skips an NSE holiday: no capture, no model call, no terminal row, one visible attempt", async () => {
    const { store, terminals, attempts } = fakeStore();
    const capture = vi.fn(async (): Promise<CaptureResult> => ({ snapshot: snapshot([gift]), diagnostics: {} }));
    const client = llm([validResponse]);
    const result = await new RunPremarketBias({ capture }, store, client, () => NOW, async () => "Test Holiday")
      .execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });

    expect(result.outcome).toBe("HOLIDAY_SKIPPED");
    expect(capture).not.toHaveBeenCalled();
    expect(client.calls).toBe(0);
    expect(terminals).toHaveLength(0);
    expect(attempts).toEqual([{ status: "INSUFFICIENT_DATA", errorDetails: { reason: "NSE_HOLIDAY", holiday: "Test Holiday" } }]);
  });

  it("runs normally on a trading day when a holiday lookup is wired", async () => {
    const { store } = fakeStore();
    const result = await new RunPremarketBias(source([gift]), store, null, () => NOW, async () => null)
      .execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    expect(result.outcome).toBe("RECORDED");
  });

  it("accepts a response wrapped in a markdown fence", async () => {
    const { store } = fakeStore();
    const result = await run(source([gift]), store, llm(["```json\n" + validResponse + "\n```"])).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    expect(result.llmStatus).toBe("VALIDATED");
  });

  it("does not call the model, or write a terminal row, without the GIFT Nifty driver on a non-final try", async () => {
    const { store, terminals, attempts } = fakeStore();
    const client = llm([validResponse]);
    const result = await run(source([evidence("ASIAN_INDEX", "market-evidence-001")], { giftNifty: "NO_QUOTE" }), store, client)
      .execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });

    expect(result.outcome).toBe("NO_DATA");
    expect(client.calls).toBe(0);
    expect(terminals).toHaveLength(0);
    expect(attempts[0]).toMatchObject({ status: "INSUFFICIENT_DATA", errorDetails: { reason: "NO_GIFT_NIFTY_QUOTE", giftNifty: "NO_QUOTE" } });
  });

  it("records an INSUFFICIENT_DATA terminal row on the final try so the day is not silently empty", async () => {
    const { store, terminals } = fakeStore();
    await run(source([]), store, llm([validResponse])).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });
    expect(terminals[0]).toMatchObject({ status: "INSUFFICIENT_DATA", assessments: null });
    expect(terminals[0]!.deterministicBaselines.NIFTY50.OPENING_GAP.GIFT_THRESHOLD).toBeNull();
  });

  it("is a no-op once the slot already has a terminal row", async () => {
    const { store, attempts } = fakeStore(true);
    const client = llm([validResponse]);
    const result = await run(source([gift]), store, client).execute({ slot: "0850", finalAttempt: true, requirePreOpen: false });
    expect(result.outcome).toBe("ALREADY_RECORDED");
    expect(client.calls).toBe(0);
    expect(attempts).toHaveLength(0);
  });

  it("lets only the first of two racing writers win", async () => {
    const { store, terminals } = fakeStore();
    await run(source([gift]), store, null).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    const second = vi.fn();
    const racing: PremarketBiasStore = { ...store, hasTerminal: async () => false, insertTerminal: async (row) => { second(row); return store.insertTerminal(row); } };
    const result = await run(source([gift]), racing, null).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false });
    expect(result.outcome).toBe("ALREADY_RECORDED");
    expect(terminals).toHaveLength(1);
  });

  it("writes no 09:10 snapshot, only a probe attempt, when there is no verified pre-open print", async () => {
    const { store, terminals, attempts } = fakeStore();
    const client = llm([validResponse]);
    const result = await run(source([gift], { preOpenProbe: { gate: "TIMESTAMP_OUTSIDE_PREOPEN_WINDOW" } }), store, client)
      .execute({ slot: "0910", finalAttempt: true, requirePreOpen: true });

    expect(result.outcome).toBe("NOT_APPLICABLE");
    expect(client.calls).toBe(0);
    expect(terminals).toHaveLength(0);
    expect(attempts[0]).toMatchObject({ status: "INSUFFICIENT_DATA", errorDetails: { reason: "NO_VERIFIED_PREOPEN_FEED", preOpenProbe: { gate: "TIMESTAMP_OUTSIDE_PREOPEN_WINDOW" } } });
  });

  it("writes a 09:10 snapshot under its own key when a pre-open print is present", async () => {
    const { store, terminals } = fakeStore();
    const result = await run(source([gift, evidence("NSE_PREOPEN", "market-evidence-002", 0.4)]), store, null)
      .execute({ slot: "0910", finalAttempt: true, requirePreOpen: true });
    expect(result.logicalRunKey).toBe("ASIA_INDIA_PREMARKET_2026-10-12_0910_V1");
    expect(terminals[0]).toMatchObject({ status: "VALID", logicalRunKey: "ASIA_INDIA_PREMARKET_2026-10-12_0910_V1" });
  });

  it("records a capture failure as an attempt and surfaces the error", async () => {
    const { store, attempts } = fakeStore();
    const broken: SnapshotSource = { capture: async () => { throw new Error("db down"); } };
    await expect(run(broken, store, null).execute({ slot: "0850", finalAttempt: false, requirePreOpen: false })).rejects.toThrow("db down");
    expect(attempts[0]).toMatchObject({ status: "FAILED", errorDetails: { stage: "capture" } });
  });
});
