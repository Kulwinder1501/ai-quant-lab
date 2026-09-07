import { describe, expect, it } from "vitest";
import { DUAL_BOT_SANDBOX } from "./bot-sandboxes.js";
import { findRegisteredStrategy, strategyKeys } from "../../modules/strategy-engine/domain/strategy-registry.js";

/**
 * The arms must stay disjoint, and nothing enforced it until a third arm was added.
 *
 * Classic-vs-Sniper answers "do the pattern strategies beat the base strategy", and that answer is
 * only readable while the arms differ in exactly one thing. The comparison is already confounded
 * before 2026-08-18 because the arms shared ideas; a strategy appearing in two rosters would
 * reintroduce the same defect silently, and the symptom would be a comparison that looks valid.
 */
describe("bot sandboxes", () => {
  it("gives every strategy to at most one arm", () => {
    const seen = new Map<string, string>();
    const overlaps: string[] = [];
    for (const bot of DUAL_BOT_SANDBOX) {
      for (const strategy of bot.allowedStrategies) {
        const owner = seen.get(strategy);
        if (owner !== undefined) overlaps.push(`${strategy}: ${owner} and ${bot.name}`);
        seen.set(strategy, bot.name);
      }
    }

    expect(overlaps, `a strategy in two arms confounds the comparison: ${overlaps.join("; ")}`)
      .toEqual([]);
  });

  it("names only strategies that exist in the registry", () => {
    /*
     * A typo would produce an arm that trades nothing and reads as a strategy with no signals --
     * indistinguishable from a quiet market, which is the failure this codebase names repeatedly.
     */
    const unknown = DUAL_BOT_SANDBOX
      .flatMap((bot) => bot.allowedStrategies.map((key) => ({ bot: bot.name, key })))
      .filter((entry) => findRegisteredStrategy(entry.key) === null);

    expect(
      unknown,
      `unknown strategy keys: ${unknown.map((u) => `${u.bot} -> ${u.key}`).join(", ")}. `
      + `Registered: ${strategyKeys().join(", ")}`,
    ).toEqual([]);
  });

  it("has distinct account names, since the account is created from the name", () => {
    // Two arms sharing a name would silently share one account and one balance, merging the very
    // populations the sandboxes exist to separate.
    const names = DUAL_BOT_SANDBOX.map((bot) => bot.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the opening balances equal, so a comparison is not confounded by the sandbox", () => {
    const balances = new Set(DUAL_BOT_SANDBOX.map((bot) => bot.initialBalance));

    expect(balances.size, "unequal starting capital changes position sizing, not just the ledger")
      .toBe(1);
  });

  it("owns momentum-scalp, which produced 0 of 37 traded ideas while unowned", () => {
    /*
     * Measured 2026-09-03 across 08-31 to 09-03: every other strategy's ideas were being acted on
     * and this one's never were, because it appeared in no roster. Pinned so removing the arm is a
     * deliberate act rather than a silent return to generating signals into a void.
     */
    const owners = DUAL_BOT_SANDBOX.filter((bot) => bot.allowedStrategies.includes("momentum-scalp"));

    expect(owners).toHaveLength(1);
    expect(owners[0]!.name).toBe("AutoBot-Scalp1m");
  });
});
