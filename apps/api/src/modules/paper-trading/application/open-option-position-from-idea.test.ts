import { describe, expect, it } from "vitest";
import { OpenOptionPositionFromIdea } from "./open-option-position-from-idea.js";
import type { PrepareOptionEntry } from "./prepare-option-entry.js";
import type { OpenPaperTrade } from "./open-paper-trade.js";
import type { RiskStateReader } from "./open-option-position-from-idea.js";

/**
 * The session entry cutoff on the agent's opening path.
 *
 * Only the cutoff is covered here. The rest of this service -- contract selection, the ask fill,
 * the risk veto -- is exercised through the callers that were already testing it; what had no
 * coverage at all was the refusal that has to happen *before* any of it runs.
 */
describe("OpenOptionPositionFromIdea session entry cutoff", () => {
  /** Throws if touched, which is the assertion: nothing downstream may run after the cutoff. */
  function explodingCollaborators() {
    const prepareEntry = {
      execute: async () => { throw new Error("prepareEntry must not be called after the cutoff"); },
    } as unknown as PrepareOptionEntry;
    const openTrade = {
      execute: async () => { throw new Error("openTrade must not be called after the cutoff"); },
    } as unknown as OpenPaperTrade;
    const riskStates: RiskStateReader = {
      findRiskState: async () => { throw new Error("findRiskState must not be called after the cutoff"); },
    };
    return { prepareEntry, openTrade, riskStates };
  }

  const input = {
    accountId: "account-1",
    instrumentId: "instrument-1",
    tradeIdeaId: "idea-1",
    notes: "",
    now: new Date("2026-09-03T09:50:00.000Z"), // 15:20 IST -- when both overnight trades opened
  };

  it("refuses after the cutoff without calling the provider or the risk engine", async () => {
    const { prepareEntry, openTrade, riskStates } = explodingCollaborators();

    const result = await new OpenOptionPositionFromIdea(prepareEntry, openTrade, riskStates)
      .execute(input);

    expect(result.opened).toBe(false);
    if (result.opened) throw new Error("unreachable");
    expect(result.reason).toBe("SESSION_ENTRY_CUTOFF");
  });

  it("does not refuse before the cutoff, so the gate cannot silently close the session early", async () => {
    // Proves the refusal is the cutoff and not an unconditional veto: at 15:14 the service runs on
    // and reaches the collaborators, which throw. A gate that always refused would pass the test
    // above and fail this one.
    const { prepareEntry, openTrade, riskStates } = explodingCollaborators();

    await expect(
      new OpenOptionPositionFromIdea(prepareEntry, openTrade, riskStates)
        .execute({ ...input, now: new Date("2026-09-03T09:44:00.000Z") }),
    ).rejects.toThrow(/must not be called after the cutoff/);
  });
});
