import type { D2InstrumentVerdict } from "./d2-premium-cost-gate.js";

/**
 * The four branches D2 may terminate on, per phase-29 §8.2.
 *
 * §5 implied PASS / FAIL with drift handled separately, which is insufficient in two distinct ways,
 * and both were being collapsed into `FAIL` by the previous two-line rule:
 *
 * - **One instrument passing and one failing is not a failure of the hypothesis.** It is a
 *   disagreement between instruments, and §2.2 forbids rescuing the result by trading whichever one
 *   worked. Reporting it as `FAIL` loses the obligation to require a new hypothesis, and reporting it
 *   as `PASS` would be the single-instrument rescue the protocol exists to prevent.
 * - **Never obtaining 60 qualified sessions is not evidence about direction at all.** It is a failure
 *   to obtain a valid test. Conflating "we ran the experiment and it lost" with "we never managed to
 *   run the experiment" would be a serious error, so it gets its own terminal branch.
 */
export type D2CrossInstrumentVerdict =
  | "CROSS_INSTRUMENT_PASS"
  | "CROSS_INSTRUMENT_DRIFT"
  | "FAIL"
  | "INSUFFICIENT_VALID_DATA";

/** §8.3: the verdict tree is only evaluated at 60 *qualified* sessions. */
export const D2_REQUIRED_QUALIFIED_SESSIONS = 60;

/** The two indices the frozen protocol tests. Both must report; neither may be dropped. */
export const D2_REQUIRED_UNDERLYINGS = ["NIFTY50", "BANKNIFTY"] as const;

export interface D2InstrumentOutcome {
  readonly underlyingSymbol: string;
  readonly verdict: D2InstrumentVerdict;
  /**
   * Sessions where **every** opportunity in the frozen set had both an entry ask and its exit bid
   * observable under `D2_MAX_QUOTE_LAG_MS` (§8.3). Not the premium session count: a session with
   * quotes can still fail qualification, and counting it would admit missing-outcome selection.
   */
  readonly qualifiedSessionCount: number;
}

export interface D2CrossInstrumentDecision {
  readonly verdict: D2CrossInstrumentVerdict;
  readonly reasons: readonly string[];
  /** Recorded on every branch so a terminal result always states what it may not be read as. */
  readonly mayProgress: boolean;
}

/**
 * Combines per-instrument gate verdicts into the single terminal D2 outcome.
 *
 * Qualification is checked first and unconditionally: below 60 qualified sessions there is no valid
 * test to read, so the per-instrument PASS/FAIL values must not be consulted at all. Letting a
 * short-of-qualification run report `FAIL` would publish a directional claim the data cannot carry.
 */
export function resolveD2CrossInstrumentVerdict(
  outcomes: readonly D2InstrumentOutcome[],
): D2CrossInstrumentDecision {
  const symbols = outcomes.map((outcome) => outcome.underlyingSymbol);
  for (const required of D2_REQUIRED_UNDERLYINGS) {
    if (!symbols.includes(required)) {
      throw new Error(`D2 cross-instrument verdict requires ${required}; received [${symbols.join(", ")}].`);
    }
  }
  if (outcomes.length !== D2_REQUIRED_UNDERLYINGS.length) {
    throw new Error(`D2 cross-instrument verdict requires exactly ${D2_REQUIRED_UNDERLYINGS.length} instruments; received ${outcomes.length}.`);
  }

  const reasons: string[] = [];

  const short = outcomes.filter((outcome) => outcome.qualifiedSessionCount < D2_REQUIRED_QUALIFIED_SESSIONS);
  for (const outcome of short) {
    reasons.push(`${outcome.underlyingSymbol} has ${outcome.qualifiedSessionCount} qualified sessions; ${D2_REQUIRED_QUALIFIED_SESSIONS} are required.`);
  }
  // `INSUFFICIENT_DATA` from the per-instrument gate means too few resolved trades to measure. That
  // is the same kind of thing as missing qualified sessions -- an absent test, not a lost one -- so
  // it terminates on the same branch rather than falling through to FAIL.
  for (const outcome of outcomes) {
    if (outcome.verdict === "INSUFFICIENT_DATA") {
      reasons.push(`${outcome.underlyingSymbol} returned INSUFFICIENT_DATA from its premium cost gate.`);
    }
  }
  if (reasons.length > 0) {
    reasons.push("INSUFFICIENT_VALID_DATA carries no directional information whatsoever.");
    return { verdict: "INSUFFICIENT_VALID_DATA", reasons, mayProgress: false };
  }

  const passed = outcomes.filter((outcome) => outcome.verdict === "PASS");
  if (passed.length === outcomes.length) {
    return {
      verdict: "CROSS_INSTRUMENT_PASS",
      reasons: [
        "Both indices cleared the frozen premium cost gate.",
        // §8.1: the frozen candidate emits no UP signals, so a PASS cannot be read as symmetric.
        "Supports the frozen lower-tail downside candidate under this prospective regime only; it does not establish bidirectional directional skill.",
      ],
      mayProgress: true,
    };
  }
  if (passed.length > 0) {
    return {
      verdict: "CROSS_INSTRUMENT_DRIFT",
      reasons: [
        `Only ${passed.map((outcome) => outcome.underlyingSymbol).join(", ")} cleared the gate.`,
        "CROSS_INSTRUMENT_DRIFT never means trade the instrument that worked: record, stop, and require a new hypothesis.",
      ],
      mayProgress: false,
    };
  }
  return {
    verdict: "FAIL",
    reasons: [
      "Neither index cleared the frozen premium cost gate.",
      "Rejects the frozen downside candidate and its economic mapping; it does not establish that directional trading is impossible.",
    ],
    mayProgress: false,
  };
}
