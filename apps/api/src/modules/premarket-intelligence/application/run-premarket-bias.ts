import { istSessionDate } from "../../platform/calendar/trading-session.js";
import type { LlmClient } from "../../../infrastructure/external/gemini-client.js";
import { validateAssessmentContract, type ValidatedAssessment } from "../domain/assessment-contract.js";
import { buildUserPrompt, promptHash, PROMPT_VERSION, SYSTEM_INSTRUCTION } from "../domain/prompt.js";
import {
  buildDeterministicBaselines,
  giftChangeFrom,
  snapshotHasPrimaryDriver,
  type DeterministicBaselines,
  type MarketSnapshot,
} from "../domain/snapshot.js";
import { PREMARKET_CONFIG_VERSION, PREMARKET_PIPELINE_NAME } from "../domain/targets.js";

export type RunSlot = "0850" | "0910";
export type AttemptStatus = "FAILED" | "INSUFFICIENT_DATA" | "SUCCESS";
export type LlmStatus = "VALIDATED" | "NOT_CONFIGURED" | "FAILED";

export interface CaptureResult {
  snapshot: MarketSnapshot;
  /** Anything worth keeping about how the capture went (gate reasons, missing sources). */
  diagnostics: Record<string, unknown>;
}

export interface SnapshotSource {
  capture(input: { sessionDate: string; runSlot: string; now: Date; slot: RunSlot }): Promise<CaptureResult>;
}

export interface TerminalSnapshotRow {
  logicalRunKey: string;
  assessmentDate: string;
  runSlot: string;
  status: "VALID" | "INSUFFICIENT_DATA";
  llmStatus: LlmStatus;
  assessments: ValidatedAssessment[] | null;
  deterministicBaselines: DeterministicBaselines;
  evidenceManifest: MarketSnapshot;
  modelMetadata: Record<string, unknown>;
}

export interface PremarketBiasStore {
  hasTerminal(logicalRunKey: string): Promise<boolean>;
  recordAttempt(input: { runSlot: string; status: AttemptStatus; errorDetails: Record<string, unknown> }): Promise<void>;
  /** First writer wins: returns false when a terminal row for this key already exists. */
  insertTerminal(row: TerminalSnapshotRow): Promise<boolean>;
}

export interface RunPremarketBiasOptions {
  slot: RunSlot;
  /**
   * Whether a run that could not produce its result may become the slot's terminal row. False on a
   * non-final try so a transient outage can still be retried; the final try sets it, so a day is recorded
   * as it was instead of leaving the slot silently empty. Covers both a snapshot with no usable primary
   * driver and a model call that failed validation or the request: the terminal row is immutable, so
   * writing "model FAILED" at the first try would make the second try a no-op and cost the day.
   */
  finalAttempt: boolean;
  /** The 09:10 update exists only if a true indicative pre-open print is present. */
  requirePreOpen: boolean;
}

export type RunOutcome = "RECORDED" | "ALREADY_RECORDED" | "NO_DATA" | "NOT_APPLICABLE" | "MODEL_RETRY_PENDING" | "HOLIDAY_SKIPPED";

/** The NSE holiday name for a session date, or null on a trading day. Injected so the run stays testable. */
export type HolidayLookup = (sessionDate: string) => Promise<string | null>;

export interface RunPremarketBiasResult {
  logicalRunKey: string;
  outcome: RunOutcome;
  llmStatus: LlmStatus | null;
  modelAttempts: number;
}

/**
 * A slot's model calls, in total. Four rather than two because the failures that cost days were Gemini's own
 * (503 and no response on 2026-10-13, -15 and -16) and the two attempts ran back to back, so a provider that
 * was briefly overloaded failed both within a second of each other.
 *
 * Only transport failures get the extra attempts, each after a wait (below). A response that arrives but fails to
 * parse or validate is a different failure -- the model answered and got it wrong -- and keeps the original two.
 */
const MAX_MODEL_ATTEMPTS = 4;
const MAX_QUALITY_ATTEMPTS = 2;
/**
 * Waits before the 2nd, 3rd and 4th attempt after a transport failure. The worst case for one slot is four
 * 60-second timeouts plus these 35 seconds, about 275 s, which ends before the final slot's timer five minutes
 * after the first.
 */
const REQUEST_RETRY_DELAYS_MS = [5_000, 10_000, 20_000] as const;

/** `{"assessments": ...}` sometimes arrives wrapped in a markdown fence despite JSON mode. */
function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)?.[1] ?? trimmed;
  return JSON.parse(unfenced);
}

export function logicalRunKey(sessionDate: string, slot: RunSlot): string {
  return `${PREMARKET_PIPELINE_NAME}_${sessionDate}_${slot}_${PREMARKET_CONFIG_VERSION}`;
}

/**
 * One pre-market run: capture a deterministic snapshot, compute the baseline, ask the model to
 * interpret it, validate strictly, and persist one immutable terminal row.
 *
 * The baseline is stored whether or not the model arm works, so a missing key or a model outage
 * costs a data point for the comparison, not the benchmark itself. The model is never shown data
 * the snapshot does not contain, and nothing it returns is repaired -- it validates or it is
 * recorded as FAILED.
 */
export class RunPremarketBias {
  constructor(
    private readonly source: SnapshotSource,
    private readonly store: PremarketBiasStore,
    private readonly llm: LlmClient | null,
    private readonly now: () => Date = () => new Date(),
    /** When given, an NSE holiday is skipped: the Indian market is shut, so there is nothing to score. */
    private readonly holidayLookup: HolidayLookup | null = null,
    /** Injected so the backoff does not make the tests wait. */
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async execute(options: RunPremarketBiasOptions): Promise<RunPremarketBiasResult> {
    const now = this.now();
    const sessionDate = istSessionDate(now);
    const key = logicalRunKey(sessionDate, options.slot);
    const base = { logicalRunKey: key, llmStatus: null, modelAttempts: 0 } as const;

    if (await this.store.hasTerminal(key)) return { ...base, outcome: "ALREADY_RECORDED" };

    // The cron runs Monday to Friday, which includes NSE holidays. GIFT Nifty and the Asian cues still
    // quote, so without this a holiday would spend a model call and store a snapshot whose outcomes can
    // never be measured. Recorded as an attempt so the skip is visible, not silent.
    const holiday = this.holidayLookup === null ? null : await this.holidayLookup(sessionDate);
    if (holiday !== null) {
      await this.store.recordAttempt({ runSlot: key, status: "INSUFFICIENT_DATA", errorDetails: { reason: "NSE_HOLIDAY", holiday } });
      return { ...base, outcome: "HOLIDAY_SKIPPED" };
    }

    let captured: CaptureResult;
    try {
      captured = await this.source.capture({ sessionDate, runSlot: key, now, slot: options.slot });
    } catch (error) {
      await this.store.recordAttempt({ runSlot: key, status: "FAILED", errorDetails: { stage: "capture", message: String(error) } });
      throw error;
    }
    const { snapshot, diagnostics } = captured;

    const hasPreOpen = snapshot.evidence.some((item) => item.category === "NSE_PREOPEN" && item.value !== null);
    if (options.requirePreOpen && !hasPreOpen) {
      await this.store.recordAttempt({ runSlot: key, status: "INSUFFICIENT_DATA", errorDetails: { reason: "NO_VERIFIED_PREOPEN_FEED", ...diagnostics } });
      return { ...base, outcome: "NOT_APPLICABLE" };
    }

    if (!snapshotHasPrimaryDriver(snapshot)) {
      await this.store.recordAttempt({ runSlot: key, status: "INSUFFICIENT_DATA", errorDetails: { reason: "NO_GIFT_NIFTY_QUOTE", ...diagnostics } });
      if (!options.finalAttempt) return { ...base, outcome: "NO_DATA" };
      await this.store.insertTerminal({
        logicalRunKey: key,
        assessmentDate: sessionDate,
        runSlot: key,
        status: "INSUFFICIENT_DATA",
        llmStatus: "NOT_CONFIGURED",
        assessments: null,
        deterministicBaselines: buildDeterministicBaselines(null),
        evidenceManifest: snapshot,
        modelMetadata: { configVersion: PREMARKET_CONFIG_VERSION, reason: "NO_GIFT_NIFTY_QUOTE" },
      });
      return { ...base, outcome: "NO_DATA" };
    }

    const baselines = buildDeterministicBaselines(giftChangeFrom(snapshot));
    const model = await this.assess(key, snapshot, sessionDate);

    // A model that failed on a non-final try is left for the next try; the final try records whatever
    // happens. A model that is simply not configured is not a failure and is stored straight away.
    if (model.llmStatus === "FAILED" && !options.finalAttempt) {
      return { logicalRunKey: key, outcome: "MODEL_RETRY_PENDING", llmStatus: "FAILED", modelAttempts: model.attempts };
    }

    const inserted = await this.store.insertTerminal({
      logicalRunKey: key,
      assessmentDate: sessionDate,
      runSlot: key,
      status: "VALID",
      llmStatus: model.llmStatus,
      assessments: model.assessments,
      deterministicBaselines: baselines,
      evidenceManifest: snapshot,
      modelMetadata: { configVersion: PREMARKET_CONFIG_VERSION, promptVersion: PROMPT_VERSION, ...model.metadata },
    });
    return {
      logicalRunKey: key,
      outcome: inserted ? "RECORDED" : "ALREADY_RECORDED",
      llmStatus: model.llmStatus,
      modelAttempts: model.attempts,
    };
  }

  private async assess(
    key: string,
    snapshot: MarketSnapshot,
    sessionDate: string,
  ): Promise<{ llmStatus: LlmStatus; assessments: ValidatedAssessment[] | null; attempts: number; metadata: Record<string, unknown> }> {
    if (!this.llm) {
      await this.store.recordAttempt({ runSlot: key, status: "SUCCESS", errorDetails: { note: "baseline only; LLM not configured" } });
      return { llmStatus: "NOT_CONFIGURED", assessments: null, attempts: 0, metadata: { llm: "NOT_CONFIGURED" } };
    }

    const user = buildUserPrompt(snapshot);
    const hash = promptHash(SYSTEM_INSTRUCTION, user);
    const knownEvidenceIds = new Set(snapshot.evidence.map((item) => item.id));
    let lastFailure: Record<string, unknown> = {};
    let qualityFailures = 0;
    let attemptsMade = 0;

    for (let attempt = 1; attempt <= MAX_MODEL_ATTEMPTS; attempt += 1) {
      if (attempt > 1 && lastFailure.stage === "request") {
        await this.sleep(REQUEST_RETRY_DELAYS_MS[Math.min(attempt - 2, REQUEST_RETRY_DELAYS_MS.length - 1)]!);
      }
      attemptsMade = attempt;
      try {
        const completion = await this.llm.completeJson({ system: SYSTEM_INSTRUCTION, user });
        let parsed: unknown;
        try {
          parsed = parseModelJson(completion.text);
        } catch {
          lastFailure = { stage: "parse", attempt, rawResponse: completion.text.slice(0, 4000) };
          await this.store.recordAttempt({ runSlot: key, status: "FAILED", errorDetails: lastFailure });
          qualityFailures += 1;
          if (qualityFailures >= MAX_QUALITY_ATTEMPTS) break;
          continue;
        }
        const result = validateAssessmentContract({
          raw: parsed,
          assessmentDate: sessionDate,
          knownEvidenceIds,
          candidateLevels: snapshot.candidateLevels,
        });
        if (!result.ok) {
          lastFailure = { stage: "validate", attempt, errors: result.errors, rawResponse: completion.text.slice(0, 4000) };
          await this.store.recordAttempt({ runSlot: key, status: "FAILED", errorDetails: lastFailure });
          qualityFailures += 1;
          if (qualityFailures >= MAX_QUALITY_ATTEMPTS) break;
          continue;
        }
        await this.store.recordAttempt({ runSlot: key, status: "SUCCESS", errorDetails: { attempt } });
        return {
          llmStatus: "VALIDATED",
          assessments: result.assessments,
          attempts: attempt,
          metadata: {
            model: completion.model,
            promptHash: hash,
            finishReason: completion.finishReason,
            promptTokens: completion.promptTokens,
            outputTokens: completion.outputTokens,
            rawResponse: completion.text,
          },
        };
      } catch (error) {
        lastFailure = { stage: "request", attempt, message: String(error) };
        await this.store.recordAttempt({ runSlot: key, status: "FAILED", errorDetails: lastFailure });
      }
    }
    return { llmStatus: "FAILED", assessments: null, attempts: attemptsMade, metadata: { model: this.llm.model, promptHash: hash, lastFailure } };
  }
}
