import { describe, expect, it } from "vitest";
import {
  classifyOpenFailure,
  DailyTradeCapReachedError,
  TradeIdeaAlreadyTakenError,
  TradeIdeaExpiredError,
  TradeIdeaUnavailableError,
} from "./paper-trade-open-errors.js";

/**
 * `expected` decides whether a bot cycle survives a failed open, so each case is asserted
 * individually rather than through a table: a mistake here either crashes runs on ordinary
 * contention (the bug this replaced) or files a broken database under "signals refused".
 */

describe("classifyOpenFailure", () => {
  it("treats losing the race for an idea as an ordinary outcome", () => {
    const classification = classifyOpenFailure(
      new TradeIdeaUnavailableError("Trade idea was not found or is no longer proposed."),
    );
    expect(classification.reason).toBe("TRADE_IDEA_UNAVAILABLE");
    expect(classification.expected).toBe(true);
  });

  it("treats an account re-offered an idea it already traded as an ordinary outcome", () => {
    // Fires on every bot cycle until the bar rolls, because the generator keeps returning the same
    // idea row for the same completed bar. Classified as a fault it would fail most runs.
    const classification = classifyOpenFailure(
      new TradeIdeaAlreadyTakenError("Account AutoBot-Sniper already holds a position from this idea."),
    );
    expect(classification.reason).toBe("TRADE_IDEA_ALREADY_TAKEN");
    expect(classification.expected).toBe(true);
  });

  it("keeps taken-by-this-account distinct from unusable-for-everyone", () => {
    // These had the same reason code before the gate admitted ACCEPTED, and collapsing them again
    // would hide whether the shared-idea fix is actually working in the live reports.
    expect(classifyOpenFailure(new TradeIdeaAlreadyTakenError("x")).reason)
      .not.toBe(classifyOpenFailure(new TradeIdeaUnavailableError("y")).reason);
  });

  it("treats an expired idea as an ordinary outcome", () => {
    const classification = classifyOpenFailure(new TradeIdeaExpiredError("expired"));
    expect(classification.reason).toBe("TRADE_IDEA_EXPIRED");
    expect(classification.expected).toBe(true);
  });

  it("treats the daily cap as the control working, not a fault", () => {
    // No account has a cap set yet, so this path had never executed. Left unclassified, the first
    // account to be given a cap would have crashed the bot on reaching it.
    const classification = classifyOpenFailure(
      new DailyTradeCapReachedError("Account AutoBot-Classic has opened 12 trade(s) on 2026-08-18."),
    );
    expect(classification.reason).toBe("DAILY_TRADE_CAP_REACHED");
    expect(classification.expected).toBe(true);
    // The message carries the count and the day, which is the whole value of the refusal line.
    expect(classification.explanation).toContain("2026-08-18");
  });

  it("does not absorb an unrecognised failure into the expected set", () => {
    // A broken database must not read as a quiet market. This is the one case that still marks the
    // run failed, and defaulting the other way would hide exactly the faults worth alerting on.
    const classification = classifyOpenFailure(new Error("connection terminated unexpectedly"));
    expect(classification.reason).toBe("OPEN_FAILED");
    expect(classification.expected).toBe(false);
    expect(classification.explanation).toBe("connection terminated unexpectedly");
  });

  it("classifies a thrown non-error without losing what was thrown", () => {
    expect(classifyOpenFailure("insufficient capital")).toEqual({
      reason: "OPEN_FAILED",
      explanation: "insufficient capital",
      expected: false,
    });
  });

  it("does not treat a subclass-shaped message as the subclass", () => {
    // The old code path matched on message text. A bare Error carrying the same words must still be
    // a fault, or reverting to string matching would look like it works.
    const classification = classifyOpenFailure(
      new Error("Trade idea was not found or is no longer proposed."),
    );
    expect(classification.reason).toBe("OPEN_FAILED");
    expect(classification.expected).toBe(false);
  });

  it("keeps the three ordinary reasons distinct from each other", () => {
    const reasons = [
      new TradeIdeaUnavailableError("a"),
      new TradeIdeaExpiredError("b"),
      new DailyTradeCapReachedError("c"),
    ].map((error) => classifyOpenFailure(error).reason);
    expect(new Set(reasons).size).toBe(3);
  });
});
