import { createHash } from "node:crypto";
import type { MarketSnapshot } from "./snapshot.js";
import { PREMARKET_INSTRUMENTS, TARGET_THRESHOLD_PCT } from "./targets.js";

export const PROMPT_VERSION = "premarket-v1";

export const SYSTEM_INSTRUCTION = [
  "You interpret a pre-market snapshot of Asian-session and overnight cues for the Indian equity indices NIFTY50 and BANKNIFTY.",
  "You are NOT a source of market data. Use only the numbered evidence items and candidate levels supplied in the user message.",
  "Never state a price, level, or percentage that is not in the supplied data. Cite the evidence ids you relied on.",
  "If the evidence does not support a call, answer UNCERTAIN. An abstention is a correct answer; a guess is not.",
  "Return a single JSON object and nothing else.",
].join(" ");

/**
 * The user prompt for one snapshot. Deterministic for a given snapshot, so its hash identifies the
 * exact input a stored assessment was produced from.
 */
export function buildUserPrompt(snapshot: MarketSnapshot): string {
  const thresholds = Object.fromEntries(
    Object.entries(TARGET_THRESHOLD_PCT).map(([target, perInstrument]) => [target, perInstrument]),
  );
  const levelsByInstrument = Object.fromEntries(
    PREMARKET_INSTRUMENTS.map((instrument) => [
      instrument,
      snapshot.candidateLevels
        .filter((level) => level.instrument === instrument)
        .map((level) => ({ id: level.id, label: level.label, price: level.price })),
    ]),
  );

  return [
    `Session date: ${snapshot.sessionDate} (Indian cash session opens 09:15 IST). Snapshot captured ${snapshot.capturedAt}.`,
    "",
    "What will be measured afterwards (percent move, inclusive at the threshold; inside the band is FLAT):",
    JSON.stringify(thresholds),
    "- OPENING_GAP: 09:15 open vs previous official close.",
    "- FIRST_60_MINUTES: 10:15 price vs 09:15 open.",
    "- FULL_SESSION: closing 15:00-15:30 VWAP vs 09:15 open.",
    "",
    "Evidence (the only market data you have):",
    JSON.stringify(snapshot.evidence),
    "",
    "Candidate key levels you may select by id (never supply a price of your own):",
    JSON.stringify(levelsByInstrument),
    "",
    "Respond with exactly this JSON shape, one entry each for NIFTY50 and BANKNIFTY, in any order:",
    JSON.stringify({
      assessments: [{
        instrument: "NIFTY50",
        opening_context: { expectation: "GAP_UP | GAP_DOWN | FLAT | UNCERTAIN", reasoning: "<=600 chars" },
        intraday_context: {
          target_horizon: "FIRST_60_MINUTES",
          expected_direction: "BULLISH | BEARISH | NEUTRAL | UNCERTAIN",
          evidence_alignment: "ALIGNED | MIXED | CONFLICTING",
          subjective_confidence: "number 0..1",
          reasoning: "<=600 chars",
        },
        full_session_context: {
          target_horizon: "FULL_SESSION",
          expected_direction: "BULLISH | BEARISH | NEUTRAL | UNCERTAIN",
          evidence_alignment: "ALIGNED | MIXED | CONFLICTING",
          subjective_confidence: "number 0..1",
          reasoning: "<=600 chars",
        },
        key_levels: [{ level_ref: "<candidate level id>", role: "SUPPORT | RESISTANCE" }],
        evidence_ids: ["<evidence id>"],
      }],
    }),
    "Use at most 4 key_levels per instrument; an empty list is fine. NEUTRAL means you expect a move inside the threshold band.",
  ].join("\n");
}

export function promptHash(system: string, user: string): string {
  return createHash("sha256").update(system).update("\n---\n").update(user).digest("hex");
}
